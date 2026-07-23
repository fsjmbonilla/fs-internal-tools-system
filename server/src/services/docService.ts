import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, docs } from '../db/schema/index.js';
import { AppError } from '../middleware/errorHandler.js';
import { linkAttachment } from './attachmentService.js';

export type DocRow = typeof docs.$inferSelect;

export interface AttachmentInfo {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export type DocDto = DocRow & { attachments: AttachmentInfo[] };

export async function listDocs(projectId: number): Promise<DocRow[]> {
  return db.select().from(docs).where(eq(docs.projectId, projectId)).orderBy(docs.title);
}

export async function getDoc(id: number): Promise<DocRow | null> {
  const [row] = await db.select().from(docs).where(eq(docs.id, id));
  return row ?? null;
}

export async function getDocAttachments(docId: number): Promise<AttachmentInfo[]> {
  const rows = await db.select().from(attachments).where(eq(attachments.docId, docId));
  return rows.map((r) => ({ id: r.id, fileName: r.fileName, mimeType: r.mimeType, sizeBytes: r.sizeBytes }));
}

export async function getDocWithAttachments(id: number): Promise<DocDto | null> {
  const doc = await getDoc(id);
  if (!doc) return null;
  return { ...doc, attachments: await getDocAttachments(id) };
}

export async function createDoc(input: {
  projectId: number;
  title: string;
  content?: string;
  userId: number;
  attachmentIds?: number[];
}): Promise<DocDto> {
  const [{ id }] = await db
    .insert(docs)
    .values({
      projectId: input.projectId,
      title: input.title,
      content: input.content ?? '',
      createdBy: input.userId,
      updatedBy: input.userId,
    })
    .$returningId();
  for (const attachmentId of input.attachmentIds ?? []) {
    const ok = await linkAttachment(attachmentId, input.userId, { docId: id });
    if (!ok) throw new AppError(400, 'invalid_attachment', `Attachment ${attachmentId} could not be linked`);
  }
  const doc = await getDocWithAttachments(id);
  return doc!;
}

export async function updateDoc(
  id: number,
  patch: { title?: string; content?: string },
  userId: number,
): Promise<void> {
  await db
    .update(docs)
    .set({ ...patch, updatedBy: userId })
    .where(eq(docs.id, id));
}

export async function addDocAttachments(docId: number, userId: number, attachmentIds: number[]): Promise<boolean> {
  for (const attachmentId of attachmentIds) {
    const ok = await linkAttachment(attachmentId, userId, { docId });
    if (!ok) return false;
  }
  return true;
}

export async function deleteDoc(id: number): Promise<void> {
  await db.delete(docs).where(eq(docs.id, id));
}
