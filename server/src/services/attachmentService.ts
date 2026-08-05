import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments } from '../db/schema/index.js';
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
