import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, notes } from '../db/schema/index.js';
import { deleteAttachmentObjectsFor, linkAttachment } from './attachmentService.js';
import { events } from './events.js';
import { createDoc, type DocRow } from './docService.js';

export type NoteRow = typeof notes.$inferSelect;

export interface NoteAttachmentInfo {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export type NoteDto = NoteRow & { attachments: NoteAttachmentInfo[] };

export async function getNoteAttachments(noteId: number): Promise<NoteAttachmentInfo[]> {
  return db
    .select({
      id: attachments.id,
      fileName: attachments.fileName,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
    })
    .from(attachments)
    .where(eq(attachments.noteId, noteId));
}

/** A note plus its attachments, or null if it is not this user's note. */
export async function getOwnNoteWithAttachments(id: number, userId: number): Promise<NoteDto | null> {
  const note = await getOwnNote(id, userId);
  if (!note) return null;
  return { ...note, attachments: await getNoteAttachments(id) };
}

/**
 * Attach already-uploaded files to a note.
 *
 * `linkAttachment` refuses an attachment someone else uploaded and refuses one
 * that is already linked, so a note cannot adopt another note's — or another
 * doc's — file. Ownership of the note itself is checked here first: without it,
 * anyone could attach to any note id and learn it existed.
 */
export async function addNoteAttachments(
  noteId: number,
  userId: number,
  attachmentIds: number[],
): Promise<boolean> {
  if (!(await getOwnNote(noteId, userId))) return false;
  for (const attachmentId of attachmentIds) {
    if (!(await linkAttachment(attachmentId, userId, { noteId }))) return false;
  }
  return true;
}

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

export type NoteFormat = 'markdown' | 'rich';

/**
 * Does this string hold a ProseMirror document?
 *
 * Structural, not schema-exact: it checks that the content parses and is shaped
 * like a doc node, which is what stops a markdown string — or arbitrary JSON —
 * being stored as `rich` and breaking the editor on the next load. Validating
 * against the *exact* node schema would mean importing the editor's schema onto
 * the server and keeping two copies in step; the editor is the authority on what
 * marks it supports, and it tolerates nodes it does not know.
 *
 * The one thing this must never do is accept HTML. It cannot: HTML is not JSON.
 */
export function isProseMirrorDoc(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const doc = parsed as { type?: unknown; content?: unknown };
  if (doc.type !== 'doc') return false;
  // An empty document is legitimate — a note someone opened and has not typed in.
  return doc.content === undefined || Array.isArray(doc.content);
}

export async function createNote(
  userId: number,
  input: { title: string; content?: string; format?: NoteFormat },
): Promise<NoteRow> {
  const [{ id }] = await db
    .insert(notes)
    .values({
      userId,
      title: input.title,
      content: input.content ?? '',
      format: input.format ?? 'markdown',
    })
    .$returningId();
  const [row] = await db.select().from(notes).where(eq(notes.id, id));
  events.emit('note.saved', { noteId: id, userId });
  return row;
}

export async function updateNote(
  id: number,
  userId: number,
  patch: { title?: string; content?: string; format?: NoteFormat; pinned?: boolean },
): Promise<boolean> {
  if (!(await getOwnNote(id, userId))) return false;
  await db
    .update(notes)
    .set(patch)
    .where(and(eq(notes.id, id), eq(notes.userId, userId)));
  events.emit('note.saved', { noteId: id, userId });
  return true;
}

export async function deleteNote(id: number, userId: number): Promise<boolean> {
  if (!(await getOwnNote(id, userId))) return false;
  // Objects first, exactly as deleteDoc does it: the attachments rows cascade
  // with the note, and once they are gone nothing records which stored files
  // belonged to it — so every deleted note would leak its images.
  await deleteAttachmentObjectsFor({ noteId: id });
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
  // Re-point the note's attachments at the new doc before the note goes. They
  // would otherwise cascade away with it, so a note containing images would
  // convert into a document full of broken ones. Their visibility widens to the
  // project's, which is precisely what converting a note into a doc means.
  await db.update(attachments).set({ noteId: null, docId: doc.id }).where(eq(attachments.noteId, id));
  await db.delete(notes).where(and(eq(notes.id, id), eq(notes.userId, userId)));
  return doc;
}
