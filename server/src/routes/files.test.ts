import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('file routes', () => {
  beforeEach(resetDb);

  it('attaches a file to a message on send and streams it back only to channel members', async () => {
    const owner = await makeUser(app, { email: 'owner@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'outsider@flowerstore.ph' });

    const chan = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'g', isPrivate: true });
    const channelId = chan.body.channel.id;

    const upload = await request(app)
      .post('/api/uploads')
      .set('Authorization', `Bearer ${owner.token}`)
      .attach('files', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/csv' });
    const attachmentId = upload.body.attachments[0].id;

    const msg = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ body: 'see attached', attachmentIds: [attachmentId] });
    expect(msg.status).toBe(201);
    expect(msg.body.message.attachments).toHaveLength(1);

    expect(
      (await request(app).get(`/api/files/${attachmentId}`).set('Authorization', `Bearer ${outsider.token}`))
        .status,
    ).toBe(404);
    const stream = await request(app)
      .get(`/api/files/${attachmentId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(stream.status).toBe(200);
    expect(stream.text).toBe('hello');
  });

  it('attaches a file to a task', async () => {
    const owner = await makeUser(app, { email: 'owner2@flowerstore.ph' });
    const proj = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'P', isPrivate: false });
    const board = await request(app)
      .get(`/api/projects/${proj.body.project.id}/board`)
      .set('Authorization', `Bearer ${owner.token}`);
    const upload = await request(app)
      .post('/api/uploads')
      .set('Authorization', `Bearer ${owner.token}`)
      .attach('files', Buffer.from('spec'), { filename: 'spec.csv', contentType: 'text/csv' });
    const attachmentId = upload.body.attachments[0].id;

    const task = await request(app)
      .post(`/api/projects/${proj.body.project.id}/tasks`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ columnId: board.body.columns[0].id, title: 'T', attachmentIds: [attachmentId] });
    expect(task.status).toBe(201);
    expect(task.body.task.attachments).toHaveLength(1);
  });

  it('attaches a file to a doc via the post-hoc attach endpoint and it shows up on GET', async () => {
    const owner = await makeUser(app, { email: 'owner3@flowerstore.ph' });
    const proj = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'P2', isPrivate: false });
    const doc = await request(app)
      .post(`/api/projects/${proj.body.project.id}/docs`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Runbook', content: '# hi' });

    const upload = await request(app)
      .post('/api/uploads')
      .set('Authorization', `Bearer ${owner.token}`)
      .attach('files', Buffer.from('img'), { filename: 'shot.png', contentType: 'image/png' });
    const attachmentId = upload.body.attachments[0].id;

    await request(app)
      .post(`/api/docs/${doc.body.doc.id}/attachments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ attachmentIds: [attachmentId] })
      .expect(201);

    const fetched = await request(app)
      .get(`/api/docs/${doc.body.doc.id}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(fetched.body.doc.attachments).toHaveLength(1);
  });
});
