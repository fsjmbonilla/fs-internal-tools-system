import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { docs } from '../db/schema/index.js';

export type DocRow = typeof docs.$inferSelect;

export async function listDocs(projectId: number): Promise<DocRow[]> {
  return db.select().from(docs).where(eq(docs.projectId, projectId)).orderBy(docs.title);
}

export async function getDoc(id: number): Promise<DocRow | null> {
  const [row] = await db.select().from(docs).where(eq(docs.id, id));
  return row ?? null;
}

export async function createDoc(input: {
  projectId: number;
  title: string;
  content?: string;
  userId: number;
}): Promise<DocRow> {
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
  const doc = await getDoc(id);
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

export async function deleteDoc(id: number): Promise<void> {
  await db.delete(docs).where(eq(docs.id, id));
}
