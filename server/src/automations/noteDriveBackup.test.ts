import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeFakeGoogle, type FakeGoogle } from '../services/google/fake.js';
import { setGooglePortForTesting } from '../services/google/port.js';
import { createNote, updateNote } from '../services/noteService.js';
import { makeUser } from '../testHelpers.js';
import { registerNoteDriveBackup, resetNoteDriveBackup, richDocToMarkdown } from './noteDriveBackup.js';

/**
 * The backup is fire-and-forget behind a debounce, so these tests register
 * with a tiny debounce and wait for the effect.
 */

const app = createApp();
let fake: FakeGoogle;

beforeEach(async () => {
  await resetDb();
  fake = makeFakeGoogle();
  setGooglePortForTesting(fake);
  registerNoteDriveBackup({ debounceMs: 10 });
});

afterEach(() => {
  resetNoteDriveBackup();
  setGooglePortForTesting(null);
});

const settle = () => new Promise((r) => setTimeout(r, 150));

async function connectedUser() {
  const user = await makeUser(app, {});
  const urlRes = await request(app)
    .get('/api/google/auth-url')
    .set('Authorization', `Bearer ${user.token}`);
  const state = new URL(urlRes.body.url).searchParams.get('state')!;
  await request(app).get(`/api/google/callback?code=good-code&state=${state}`);
  return user;
}

describe('note drive backup', () => {
  it('writes a markdown copy into the owner Drive folder and reuses the file on the next save', async () => {
    const { userId } = await connectedUser();
    const note = await createNote(userId, { title: 'Plans', content: 'first draft' });
    await settle();

    const folder = fake.drive.find((f) => f.isFolder && f.name === 'FS Notes');
    expect(folder).toBeDefined();
    const file = fake.drive.find((f) => !f.isFolder && f.parentId === folder!.id);
    expect(file?.name).toBe(`Plans (note-${note.id}).md`);
    expect(fake.uploads.get(file!.id)?.toString('utf8')).toBe('first draft');

    await updateNote(note.id, userId, { content: 'second draft' });
    await settle();
    const filesAfter = fake.drive.filter((f) => !f.isFolder);
    expect(filesAfter).toHaveLength(1); // updated in place, not duplicated
    expect(fake.uploads.get(file!.id)?.toString('utf8')).toBe('second draft');
  });

  it('debounces: a burst of saves lands one Drive write', async () => {
    const { userId } = await connectedUser();
    const note = await createNote(userId, { title: 'Burst', content: 'v1' });
    await updateNote(note.id, userId, { content: 'v2' });
    await updateNote(note.id, userId, { content: 'v3' });
    await settle();
    expect(fake.drive.filter((f) => !f.isFolder)).toHaveLength(1);
    const file = fake.drive.find((f) => !f.isFolder)!;
    expect(fake.uploads.get(file.id)?.toString('utf8')).toBe('v3');
  });

  it('skips silently when the owner has no Google connection', async () => {
    const { userId } = await makeUser(app, {});
    await createNote(userId, { title: 'Offline', content: 'stays local' });
    await settle();
    expect(fake.drive).toHaveLength(0);
  });

  it('renders a rich note readable', () => {
    const pm = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
            },
          ],
        },
      ],
    });
    expect(richDocToMarkdown(pm)).toBe('## Title\n\n**bold**\n\n- one\n');
  });
});
