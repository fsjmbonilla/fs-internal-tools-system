import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { attachments } from '../db/schema/index.js';
import { logger } from '../logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { getStorageDriver } from '../storage/index.js';

export type AttachmentDto = typeof attachments.$inferSelect;

export const MIME_WHITELIST = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

/**
 * Types with no magic bytes to sniff. `file-type` returns undefined for these
 * because they are plain text, so their declared type is all we have — which is
 * safe only because none of them can execute in a browser and the file route
 * serves everything but images and PDFs as a download.
 */
const UNSNIFFABLE = new Set(['text/csv']);

/**
 * Office formats are ZIP containers and legacy Office formats are CFB
 * containers, so sniffing reports the container, not the document. Accept the
 * container as evidence for its family rather than demanding an exact match.
 */
const CONTAINER_EQUIVALENTS: Record<string, string[]> = {
  'application/zip': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
  ],
  'application/x-cfb': [
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
  ],
};

/** Served inline in the browser; everything else downloads. */
export const INLINEABLE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

/**
 * Verify the bytes match the declared type.
 *
 * multer's fileFilter can only see `file.mimetype`, which the client sends and
 * therefore controls: an HTML payload labelled `image/png` passed the whitelist
 * and was later served back with that Content-Type. Sniffing the magic bytes is
 * what makes the whitelist mean anything.
 */
export async function verifyMime(buffer: Buffer, declared: string): Promise<boolean> {
  if (!MIME_WHITELIST.has(declared)) return false;
  const { fileTypeFromBuffer } = await import('file-type');
  const sniffed = await fileTypeFromBuffer(buffer);

  if (!sniffed) {
    // Nothing recognizable. Only legitimate for the text formats; for anything
    // else it means the bytes are not what the client claimed.
    return UNSNIFFABLE.has(declared);
  }
  if (sniffed.mime === declared) return true;
  return (CONTAINER_EQUIVALENTS[sniffed.mime] ?? []).includes(declared);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

export async function createUnlinkedAttachment(input: {
  uploaderId: number;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<AttachmentDto> {
  if (!(await verifyMime(input.buffer, input.mimeType))) {
    throw new AppError(
      400,
      'unsupported_mime',
      `File contents do not match the declared type ${input.mimeType}`,
    );
  }
  const key = `uploads/${randomUUID()}-${sanitizeFileName(input.fileName)}`;
  await getStorageDriver().put(key, input.buffer, input.mimeType);
  const [{ id }] = await db
    .insert(attachments)
    .values({
      uploaderId: input.uploaderId,
      storageKey: key,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    })
    .$returningId();
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
  return row;
}

export async function linkAttachment(
  id: number,
  uploaderId: number,
  target: { messageId?: number; taskId?: number; docId?: number },
): Promise<boolean> {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
  if (!row || row.uploaderId !== uploaderId) return false;
  if (row.messageId || row.taskId || row.docId) return false;
  await db.update(attachments).set(target).where(eq(attachments.id, id));
  return true;
}

export async function getAttachment(id: number): Promise<AttachmentDto | null> {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
  return row ?? null;
}

export async function getAttachmentsFor(target: {
  messageId?: number;
  taskId?: number;
  docId?: number;
}): Promise<AttachmentDto[]> {
  if (target.messageId) {
    return db.select().from(attachments).where(eq(attachments.messageId, target.messageId));
  }
  if (target.taskId) {
    return db.select().from(attachments).where(eq(attachments.taskId, target.taskId));
  }
  if (target.docId) {
    return db.select().from(attachments).where(eq(attachments.docId, target.docId));
  }
  return [];
}

const UPLOAD_PREFIX = 'uploads/';

/**
 * Delete the stored objects belonging to a parent, then let the caller delete
 * the parent itself.
 *
 * The `attachments` foreign keys cascade, so deleting a task or doc removes the
 * rows — and with them the only record of which objects existed. Nothing else
 * ever deleted those objects, so every deleted task or doc leaked its files:
 * on S3 that is a bill, on local disk it is the same slow disk-fill that took a
 * production box to 96%.
 *
 * Called before the parent goes, because after the cascade the keys are gone.
 */
export async function deleteAttachmentObjectsFor(target: {
  taskId?: number;
  docId?: number;
  messageId?: number;
}): Promise<number> {
  const rows = await getAttachmentsFor(target);
  const driver = getStorageDriver();
  let deleted = 0;
  for (const row of rows) {
    try {
      await driver.delete(row.storageKey);
      deleted++;
    } catch (err) {
      // A missing or unreachable object must not block deleting the parent —
      // the orphan sweep will catch whatever is left behind.
      logger.warn({ err, storageKey: row.storageKey }, 'attachment object delete failed');
    }
  }
  return deleted;
}

/**
 * Delete stored objects that no attachment row points at.
 *
 * The row-driven cleanup above cannot see these: they are what is left when a
 * row disappears without its object being deleted first — a cascade that
 * predates this code, a crash between the two deletes, or a failed upload that
 * stored its bytes before the insert.
 */
export async function sweepOrphanObjects(): Promise<number> {
  const driver = getStorageDriver();
  const [keys, rows] = await Promise.all([
    driver.list(UPLOAD_PREFIX),
    db.select({ storageKey: attachments.storageKey }).from(attachments),
  ]);
  const known = new Set(rows.map((r) => r.storageKey));
  let deleted = 0;
  for (const key of keys) {
    if (known.has(key)) continue;
    try {
      await driver.delete(key);
      deleted++;
      logger.info({ storageKey: key }, 'orphan object swept');
    } catch (err) {
      logger.warn({ err, storageKey: key }, 'orphan object delete failed');
    }
  }
  return deleted;
}

export async function gcUnlinkedAttachments(olderThanHours: number): Promise<number> {
  const cutoff = sql`DATE_SUB(NOW(), INTERVAL ${olderThanHours} HOUR)`;
  const stale = await db
    .select()
    .from(attachments)
    .where(
      and(
        isNull(attachments.messageId),
        isNull(attachments.taskId),
        isNull(attachments.docId),
        lt(attachments.createdAt, cutoff),
      ),
    );
  for (const row of stale) {
    await getStorageDriver().delete(row.storageKey);
    await db.delete(attachments).where(eq(attachments.id, row.id));
  }
  return stale.length;
}

const GC_LOCK = 'fs_attachment_gc';

/**
 * Run the whole cleanup under an advisory lock.
 *
 * The interval that drives this runs in every process, so a second instance —
 * or a PM2 restart overlapping the old worker — would sweep concurrently and
 * race on the same rows and objects. `GET_LOCK` with a zero timeout means a
 * process that does not get the lock simply skips this round.
 */
export async function runAttachmentGc(unlinkedOlderThanHours = 24): Promise<{
  ran: boolean;
  unlinked: number;
  orphans: number;
}> {
  // One dedicated connection for both calls. GET_LOCK is scoped to a session, so
  // acquiring and releasing through the pool could land on different
  // connections — the release would then be a no-op and the lock would linger
  // until its original connection happened to be recycled.
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT GET_LOCK(?, 0) AS locked', [GC_LOCK]);
    if ((rows as { locked: number | null }[])[0]?.locked !== 1) {
      logger.debug('attachment GC skipped — another process holds the lock');
      return { ran: false, unlinked: 0, orphans: 0 };
    }
    try {
      const unlinked = await gcUnlinkedAttachments(unlinkedOlderThanHours);
      const orphans = await sweepOrphanObjects();
      if (unlinked || orphans) logger.info({ unlinked, orphans }, 'attachment GC done');
      return { ran: true, unlinked, orphans };
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [GC_LOCK]);
    }
  } finally {
    conn.release();
  }
}
