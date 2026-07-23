import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('project routes', () => {
  beforeEach(resetDb);

  it('creates a project with default columns, 404s a private one for outsiders', async () => {
    const owner = await makeUser(app, { email: 'owner@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'outsider@flowerstore.ph' });

    const create = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Secret Proj', isPrivate: true });
    expect(create.status).toBe(201);
    const projectId = create.body.project.id;

    const board = await request(app)
      .get(`/api/projects/${projectId}/board`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(board.body.columns.map((c: { name: string }) => c.name)).toEqual([
      'Todo',
      'In Progress',
      'Done',
    ]);

    expect(
      (await request(app).get(`/api/projects/${projectId}`).set('Authorization', `Bearer ${outsider.token}`))
        .status,
    ).toBe(404);
  });

  it('creates a task, moves it, adds a comment, and manages docs', async () => {
    const owner = await makeUser(app, { email: 'owner2@flowerstore.ph' });
    const proj = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Board Proj', isPrivate: false });
    const projectId = proj.body.project.id;
    const board = await request(app)
      .get(`/api/projects/${projectId}/board`)
      .set('Authorization', `Bearer ${owner.token}`);
    const todoId = board.body.columns[0].id;
    const doneId = board.body.columns[2].id;

    const task = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ columnId: todoId, title: 'Ship it' });
    expect(task.status).toBe(201);

    await request(app)
      .post(`/api/tasks/${task.body.task.id}/move`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ columnId: doneId })
      .expect(200);

    await request(app)
      .post(`/api/tasks/${task.body.task.id}/comments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ body: 'done!' })
      .expect(201);

    const comments = await request(app)
      .get(`/api/tasks/${task.body.task.id}/comments`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(comments.body.comments).toHaveLength(1);

    const doc = await request(app)
      .post(`/api/projects/${projectId}/docs`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Runbook', content: '# hi' });
    expect(doc.status).toBe(201);

    const docs = await request(app)
      .get(`/api/projects/${projectId}/docs`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(docs.body.docs).toHaveLength(1);
  });
});
