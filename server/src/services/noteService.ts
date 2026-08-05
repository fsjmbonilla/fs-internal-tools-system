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

/** How many notes a user owns. A count only — never their contents. */
export async function countNotes(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(notes)
    .where(eq(notes.userId, userId));
  return Number(row.n);
}

/**
 * Move every note from one person to another. Offboarding.
 *
 * Notes are private to their owner, which means that when someone leaves, their
 * notes become unreachable — the rows outlive the person and nobody can open
 * them. Deleting the account would cascade them away entirely (`onDelete:
 * cascade`), so the work would simply be lost.
 *
 * Deliberately a *transfer*, not a grant: it changes who owns each note and
 * gives the caller no way to read them. An admin can hand a departing
 * colleague's notes to their manager without acquiring the power to read
 * everyone's notes, which is the property that makes notes worth calling
 * private at all.
 */
export async function transferNotes(fromUserId: number, toUserId: number): Promise<number> {
  const moved = await countNotes(fromUserId);
  if (moved === 0) return 0;
  await db.update(notes).set({ userId: toUserId }).where(eq(notes.userId, fromUserId));
  return moved;
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
