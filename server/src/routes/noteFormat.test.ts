/**
 * Notes as rich documents — Phase 9, step 3.
 *
 * `format` decides which renderer the client uses, so a row whose content does
 * not match its format is a note the editor cannot open and the user cannot
 * repair. The edge is where that has to be caught.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { isProseMirrorDoc } from '../services/noteService.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` }) as Record<string, string>;

const DOC = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
});

describe('isProseMirrorDoc', () => {
  it('accepts a document, including an empty one', () => {
    expect(isProseMirrorDoc(DOC)).toBe(true);
    expect(isProseMirrorDoc('{"type":"doc"}')).toBe(true);
    expect(isProseMirrorDoc('{"type":"doc","content":[]}')).toBe(true);
  });

  it('rejects anything that is not one', () => {
    expect(isProseMirrorDoc('# just markdown')).toBe(false);
    expect(isProseMirrorDoc('')).toBe(false);
    expect(isProseMirrorDoc('null')).toBe(false);
    expect(isProseMirrorDoc('[]')).toBe(false);
    expect(isProseMirrorDoc('{"type":"paragraph"}')).toBe(false);
    expect(isProseMirrorDoc('{"content":[]}')).toBe(false);
    // HTML is the thing this must never let through, and it cannot: not JSON.
    expect(isProseMirrorDoc('<p onclick="alert(1)">hi</p>')).toBe(false);
  });
});

describe('notes carry a format', () => {
  beforeEach(resetDb);

  it('defaults to markdown, so every existing note keeps rendering as authored', async () => {
    const user = await makeUser(app, { email: 'fmt1@flowerstore.ph' });
    const res = await request(app)
      .post('/api/notes')
      .set(auth(user.token))
      .send({ title: 'Old style', content: '# heading' });
    expect(res.status).toBe(201);
    expect(res.body.note.format).toBe('markdown');
  });

  it('stores a rich document', async () => {
    const user = await makeUser(app, { email: 'fmt2@flowerstore.ph' });
    const res = await request(app)
      .post('/api/notes')
      .set(auth(user.token))
      .send({ title: 'New style', content: DOC, format: 'rich' });
    expect(res.status).toBe(201);
    expect(res.body.note.format).toBe('rich');

    const fetched = await request(app).get(`/api/notes/${res.body.note.id}`).set(auth(user.token));
    expect(JSON.parse(fetched.body.note.content).type).toBe('doc');
  });

  it('refuses rich content that is not a document', async () => {
    const user = await makeUser(app, { email: 'fmt3@flowerstore.ph' });
    const res = await request(app)
      .post('/api/notes')
      .set(auth(user.token))
      .send({ title: 'Lying about format', content: '# markdown really', format: 'rich' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('refuses it on patch too', async () => {
    const user = await makeUser(app, { email: 'fmt4@flowerstore.ph' });
    const note = await request(app)
      .post('/api/notes')
      .set(auth(user.token))
      .send({ title: 'Upgrade me', content: 'plain' });

    const bad = await request(app)
      .patch(`/api/notes/${note.body.note.id}`)
      .set(auth(user.token))
      .send({ content: 'still markdown', format: 'rich' });
    expect(bad.status).toBe(400);

    const good = await request(app)
      .patch(`/api/notes/${note.body.note.id}`)
      .set(auth(user.token))
      .send({ content: DOC, format: 'rich' });
    expect(good.status).toBe(200);
    expect(good.body.note.format).toBe('rich');
    // The patch response carries attachments, like GET — the editor renders from it.
    expect(good.body.note.attachments).toEqual([]);
  });

  it('lets a note stay markdown when only the title changes', async () => {
    const user = await makeUser(app, { email: 'fmt5@flowerstore.ph' });
    const note = await request(app)
      .post('/api/notes')
      .set(auth(user.token))
      .send({ title: 'Keep me', content: '# markdown' });

    const res = await request(app)
      .patch(`/api/notes/${note.body.note.id}`)
      .set(auth(user.token))
      .send({ title: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.note.format).toBe('markdown');
    expect(res.body.note.content).toBe('# markdown');
  });
});
