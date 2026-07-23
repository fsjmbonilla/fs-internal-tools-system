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
  if (!MIME_WHITELIST.has(input.mimeType)) {
    throw new AppError(400, 'unsupported_mime', `File type ${input.mimeType} is not allowed`);
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
