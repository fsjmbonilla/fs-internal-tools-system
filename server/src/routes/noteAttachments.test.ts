/**
 * Attachments on a note — Phase 9, step 1.
 *
 * The interesting property is not that it works, it is who it refuses. A note is
 * private to its owner, and an admin can transfer a departing colleague's notes
 * without reading them. That is only true if the admin cannot read the note's
 * *files* either, so this is the one place where admin reach is deliberately
 * narrower than everywhere else in the platform.
 */

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db/index.js';
import { attachments } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` }) as Record<string, string>;

// A real 1x1 PNG: uploads are verified against their bytes, not the declared type.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(token: string, name = 'shot.png') {
  const res = await request(app)
    .post('/api/uploads')
    .set(auth(token))
    .attach('files', PNG, { filename: name, contentType: 'image/png' });
  expect(res.status).toBe(201);
  return res.body.attachments[0].id as number;
}

async function makeNote(token: string, title = 'With pictures') {
  const res = await request(app).post('/api/notes').set(auth(token)).send({ title, content: 'body' });
  expect(res.status).toBe(201);
  return res.body.note.id as number;
}

describe('note attachments', () => {
  beforeEach(resetDb);

  it('links an upload to a note and returns it with the note', async () => {
    const owner = await makeUser(app, { email: 'na-owner@flowerstore.ph' });
    const noteId = await makeNote(owner.token);
    const attachmentId = await upload(owner.token);

    const res = await request(app)
      .post(`/api/notes/${noteId}/attachments`)
      .set(auth(owner.token))
      .send({ attachmentIds: [attachmentId] });

    expect(res.status).toBe(201);
    expect(res.body.note.attachments).toHaveLength(1);
    expect(res.body.note.attachments[0].fileName).toBe('shot.png');

    // And it comes back on a plain GET, which is what the editor renders from.
    const fetched = await request(app).get(`/api/notes/${noteId}`).set(auth(owner.token));
    expect(fetched.body.note.attachments[0].id).toBe(attachmentId);
  });

  it('serves the file to its owner', async () => {
    const owner = await makeUser(app, { email: 'na-owner2@flowerstore.ph' });
    const noteId = await makeNote(owner.token);
    const attachmentId = await upload(owner.token);
    await request(app)
      .post(`/api/notes/${noteId}/attachments`)
      .set(auth(owner.token))
      .send({ attachmentIds: [attachmentId] });

    const file = await request(app).get(`/api/files/${attachmentId}`).set(auth(owner.token));
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('image/png');
    // Inline, because it is an image — but sandboxed and nosniff regardless.
    expect(file.headers['content-disposition']).toContain('inline');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
  });

  it('404s the file for another user AND for an admin', async () => {
    const owner = await makeUser(app, { email: 'na-owner3@flowerstore.ph' });
    const other = await makeUser(app, { email: 'na-other@flowerstore.ph' });
    const admin = await makeUser(app, { email: 'na-admin@flowerstore.ph', admin: true });
    const noteId = await makeNote(owner.token);
    const attachmentId = await upload(owner.token);
    await request(app)
      .post(`/api/notes/${noteId}/attachments`)
      .set(auth(owner.token))
      .send({ attachmentIds: [attachmentId] });

    expect((await request(app).get(`/api/files/${attachmentId}`).set(auth(other.token))).status).toBe(404);
    // The admin exception: everywhere else isAdmin opens the door. Not here.
    expect((await request(app).get(`/api/files/${attachmentId}`).set(auth(admin.token))).status).toBe(404);
  });

  it("404s rather than 400s when the note is someone else's", async () => {
    const owner = await makeUser(app, { email: 'na-owner4@flowerstore.ph' });
    const other = await makeUser(app, { email: 'na-other2@flowerstore.ph' });
    const noteId = await makeNote(owner.token);
    const attachmentId = await upload(other.token);

    // A 400 here would confirm the note exists. It must not.
    const res = await request(app)
      .post(`/api/notes/${noteId}/attachments`)
      .set(auth(other.token))
      .send({ attachmentIds: [attachmentId] });
    expect(res.status).toBe(404);
  });

  it("refuses an attachment uploaded by someone else", async () => {
    const owner = await makeUser(app, { email: 'na-owner5@flowerstore.ph' });
    const other = await makeUser(app, { email: 'na-other3@flowerstore.ph' });
    const noteId = await makeNote(owner.token);
    const theirs = await upload(other.token);

    const res = await request(app)
      .post(`/api/notes/${noteId}/attachments`)
      .set(auth(owner.token))
      .send({ attachmentIds: [theirs] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_attachment');
  });

  it('refuses an attachment that already belongs to something else', async () => {
    const owner = await makeUser(app, { email: 'na-owner6@flowerstore.ph' });
    const first = await makeNote(owner.token, 'First');
    const second = await makeNote(owner.token, 'Second');
    const attachmentId = await upload(owner.token);
    await request(app)
      .post(`/api/notes/${first}/attachments`)
      .set(auth(owner.token))
      .send({ attachmentIds: [attachmentId] });

    const res = await request(app)
      .post(`/api/notes/${second}/attachments`)
      .set(auth(owner.token))
      .send({ attachmentIds: [attachmentId] });
    expect(res.status).toBe(400);
  });

  it('carries attachments across when a note becomes a doc', async () => {
    // Otherwise converting a note full of images produces a document full of
    // broken ones: the rows would cascade away with the note.
    const owner = await makeUser(app, { email: 'na-owner7@flowerstore.ph' });
    const project = await request(app)
      .post('/api/projects')
      .set(auth(owner.token))
      .send({ name: 'Destination', isPrivate: false });
    const noteId = await makeNote(owner.token, 'Convert with images');
    const attachmentId = await upload(owner.token);
    await request(app)
      .post(`/api/notes/${noteId}/attachments`)
      .set(auth(owner.token))
      .send({ attachmentIds: [attachmentId] });

    const res = await request(app)
      .post(`/api/notes/${noteId}/convert-to-doc`)
      .set(auth(owner.token))
      .send({ projectId: project.body.project.id });
    expect(res.status).toBe(201);

    const [row] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
    expect(row.noteId).toBeNull();
    expect(row.docId).toBe(res.body.doc.id);
    // And it is still fetchable — now under the doc's project visibility.
    expect((await request(app).get(`/api/files/${attachmentId}`).set(auth(owner.token))).status).toBe(200);
  });

  it('deletes the stored object when the note is deleted', async () => {
    const owner = await makeUser(app, { email: 'na-owner8@flowerstore.ph' });
    const noteId = await makeNote(owner.token, 'Doomed');
    const attachmentId = await upload(owner.token);
    await request(app)
      .post(`/api/notes/${noteId}/attachments`)
      .set(auth(owner.token))
      .send({ attachmentIds: [attachmentId] });

    expect((await request(app).delete(`/api/notes/${noteId}`).set(auth(owner.token))).status).toBe(200);

    // The row cascaded with the note; the point of the fix is that the bytes went too.
    expect(await db.select().from(attachments).where(eq(attachments.id, attachmentId))).toHaveLength(0);
    expect((await request(app).get(`/api/files/${attachmentId}`).set(auth(owner.token))).status).toBe(404);
  });
});
