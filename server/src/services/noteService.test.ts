import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { createProject } from './projectService.js';
import {
  convertNoteToDoc,
  createNote,
  deleteNote,
  getOwnNote,
  listNotes,
  updateNote,
} from './noteService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('noteService', () => {
  beforeEach(resetDb);

  it('is strictly owner-scoped', async () => {
    const a = await seedUser('a@flowerstore.ph');
    const b = await seedUser('b@flowerstore.ph');
    const note = await createNote(a, { title: 'Mine', content: 'secret' });
    expect(await getOwnNote(note.id, a)).not.toBeNull();
    expect(await getOwnNote(note.id, b)).toBeNull();
    expect(await updateNote(note.id, b, { title: 'hacked' })).toBe(false);
    expect(await deleteNote(note.id, b)).toBe(false);
    expect((await listNotes(a)).map((n) => n.id)).toContain(note.id);
    expect((await listNotes(b)).map((n) => n.id)).not.toContain(note.id);
  });

  it('searches and filters pinned within the owner scope only', async () => {
    const a = await seedUser('a@flowerstore.ph');
    await createNote(a, { title: 'Grocery list', content: 'milk eggs bread' });
    const pinned = await createNote(a, { title: 'Important', content: 'unique-note-token' });
    await updateNote(pinned.id, a, { pinned: true });

    const results = await listNotes(a, { q: 'unique-note-token' });
    expect(results.map((n) => n.id)).toEqual([pinned.id]);

    const pinnedOnly = await listNotes(a, { pinnedOnly: true });
    expect(pinnedOnly.map((n) => n.id)).toEqual([pinned.id]);
  });

  it('convert-to-doc creates the doc in the target project and removes the note', async () => {
    const a = await seedUser('a@flowerstore.ph');
    const proj = await createProject({ name: 'P', isPrivate: false, createdBy: a });
    const note = await createNote(a, { title: 'Share me', content: 'body text' });
    const doc = await convertNoteToDoc(note.id, a, proj.id);
    expect(doc?.title).toBe('Share me');
    expect(doc?.content).toBe('body text');
    expect(await getOwnNote(note.id, a)).toBeNull();
  });
});
