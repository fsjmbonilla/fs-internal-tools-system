import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { notes } from '../db/schema/index.js';
import { createDoc, type DocRow } from './docService.js';

export type NoteRow = typeof notes.$inferSelect;

export async function listNotes(
  userId: number,
  opts: { q?: string; pinnedOnly?: boolean } = {},
): Promise<NoteRow[]> {
  const conditions = [eq(notes.userId, userId)];
  if (opts.pinnedOnly) conditions.push(eq(notes.pinned, true));
  if (opts.q) {
    conditions.push(
      sql`MATCH(${notes.title}, ${notes.content}) AGAINST(${opts.q} IN NATURAL LANGUAGE MODE)`,
    );
  }
  return db
    .select()
    .from(notes)
    .where(and(...conditions))
    .orderBy(desc(notes.pinned), desc(notes.updatedAt));
}

export async function getOwnNote(id: number, userId: number): Promise<NoteRow | null> {
  const [row] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, id), eq(notes.userId, userId)));
  return row ?? null;
}

export async function createNote(
  userId: number,
  input: { title: string; content?: string },
): Promise<NoteRow> {
  const [{ id }] = await db
    .insert(notes)
    .values({ userId, title: input.title, content: input.content ?? '' })
    .$returningId();
  const [row] = await db.select().from(notes).where(eq(notes.id, id));
  return row;
}

export async function updateNote(
  id: number,
  userId: number,
  patch: { title?: string; content?: string; pinned?: boolean },
): Promise<boolean> {
  if (!(await getOwnNote(id, userId))) return false;
  await db
    .update(notes)
    .set(patch)
    .where(and(eq(notes.id, id), eq(notes.userId, userId)));
  return true;
}

export async function deleteNote(id: number, userId: number): Promise<boolean> {
  if (!(await getOwnNote(id, userId))) return false;
  await db.delete(notes).where(and(eq(notes.id, id), eq(notes.userId, userId)));
  return true;
}

export async function convertNoteToDoc(
  id: number,
  userId: number,
  projectId: number,
): Promise<DocRow | null> {
  const note = await getOwnNote(id, userId);
  if (!note) return null;
  const doc = await createDoc({ projectId, title: note.title, content: note.content, userId });
  await db.delete(notes).where(and(eq(notes.id, id), eq(notes.userId, userId)));
  return doc;
}
