import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('notes routes', () => {
  beforeEach(resetDb);

  it('is invisible to everyone else, including admins', async () => {
    const owner = await makeUser(app, { email: 'owner@flowerstore.ph' });
    const admin = await makeUser(app, { email: 'admin@flowerstore.ph', admin: true });

    const note = await request(app)
      .post('/api/notes')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Private', content: 'shh' });
    expect(note.status).toBe(201);
    const noteId = note.body.note.id;

    expect(
      (await request(app).get(`/api/notes/${noteId}`).set('Authorization', `Bearer ${admin.token}`)).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/notes/${noteId}`).set('Authorization', `Bearer ${owner.token}`)).status,
    ).toBe(200);
  });

  it('converts to a project doc and removes the note', async () => {
    const owner = await makeUser(app, { email: 'owner2@flowerstore.ph' });
    const proj = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'P', isPrivate: false });
    const note = await request(app)
      .post('/api/notes')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Convert me', content: 'body' });

    const converted = await request(app)
      .post(`/api/notes/${note.body.note.id}/convert-to-doc`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ projectId: proj.body.project.id });
    expect(converted.status).toBe(201);
    expect(converted.body.doc.title).toBe('Convert me');

    expect(
      (await request(app).get(`/api/notes/${note.body.note.id}`).set('Authorization', `Bearer ${owner.token}`))
        .status,
    ).toBe(404);
  });
});
