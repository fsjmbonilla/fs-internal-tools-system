/**
 * Phase 5 Task B2 — reading a project is open, changing it is not.
 *
 * Phase 3 shipped mutation to any viewer and flagged it as a fast-follow. The
 * visibility rule is unchanged: invisible is still 404. Visible-but-not-a-member
 * is 403, which leaks nothing the caller was not already told.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` } as Record<string, string>);

describe('project membership gates mutation', () => {
  beforeEach(resetDb);

  async function setup() {
    const owner = await makeUser(app, { email: `own${Date.now()}@flowerstore.ph` });
    const visitor = await makeUser(app, { email: `vis${Date.now()}@flowerstore.ph` });
    const admin = await makeUser(app, { email: `adm${Date.now()}@flowerstore.ph`, admin: true });

    // Public, so the visitor can see it but is not a member of it.
    const project = await request(app)
      .post('/api/projects')
      .set(auth(owner.token))
      .send({ name: 'Open Project', isPrivate: false });
    const projectId = project.body.project.id;

    const board = await request(app).get(`/api/projects/${projectId}/board`).set(auth(owner.token));
    const columnId = board.body.columns[0].id;

    const task = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set(auth(owner.token))
      .send({ columnId, title: 'Owned task' });
    const doc = await request(app)
      .post(`/api/projects/${projectId}/docs`)
      .set(auth(owner.token))
      .send({ title: 'Spec', content: 'x' });

    return {
      owner,
      visitor,
      admin,
      projectId,
      columnId,
      taskId: task.body.task.id,
      docId: doc.body.doc.id,
    };
  }

  it('lets a non-member read everything', async () => {
    const s = await setup();
    for (const path of [
      `/api/projects/${s.projectId}`,
      `/api/projects/${s.projectId}/board`,
      `/api/projects/${s.projectId}/docs`,
      `/api/tasks/${s.taskId}`,
      `/api/tasks/${s.taskId}/comments`,
      `/api/docs/${s.docId}`,
    ]) {
      const res = await request(app).get(path).set(auth(s.visitor.token));
      expect(res.status, path).toBe(200);
    }
  });

  it('refuses every mutation from a non-member', async () => {
    const s = await setup();
    const v = auth(s.visitor.token);
    const cases: [string, () => Promise<{ status: number }>][] = [
      ['rename project', () => request(app).patch(`/api/projects/${s.projectId}`).set(v).send({ name: 'Hijacked' })],
      ['create task', () => request(app).post(`/api/projects/${s.projectId}/tasks`).set(v).send({ columnId: s.columnId, title: 'x' })],
      ['create doc', () => request(app).post(`/api/projects/${s.projectId}/docs`).set(v).send({ title: 'x' })],
      ['edit task', () => request(app).patch(`/api/tasks/${s.taskId}`).set(v).send({ title: 'Hijacked' })],
      ['move task', () => request(app).post(`/api/tasks/${s.taskId}/move`).set(v).send({ columnId: s.columnId })],
      ['delete task', () => request(app).delete(`/api/tasks/${s.taskId}`).set(v)],
      ['comment on task', () => request(app).post(`/api/tasks/${s.taskId}/comments`).set(v).send({ body: 'hi' })],
      ['edit doc', () => request(app).patch(`/api/docs/${s.docId}`).set(v).send({ title: 'Hijacked' })],
      ['delete doc', () => request(app).delete(`/api/docs/${s.docId}`).set(v)],
    ];
    for (const [label, run] of cases) {
      expect((await run()).status, label).toBe(403);
    }
  });

  it('does not let a non-member add themselves as a member', async () => {
    // Otherwise membership is self-service and the rule above means nothing.
    const s = await setup();
    const res = await request(app)
      .post(`/api/projects/${s.projectId}/members`)
      .set(auth(s.visitor.token))
      .send({ userId: s.visitor.userId });
    expect(res.status).toBe(403);
  });

  it('allows the same mutations once they are a member', async () => {
    const s = await setup();
    await request(app)
      .post(`/api/projects/${s.projectId}/members`)
      .set(auth(s.owner.token))
      .send({ userId: s.visitor.userId });

    expect(
      (await request(app).patch(`/api/tasks/${s.taskId}`).set(auth(s.visitor.token)).send({ title: 'Fine' }))
        .status,
    ).toBe(200);
    expect(
      (await request(app).patch(`/api/docs/${s.docId}`).set(auth(s.visitor.token)).send({ title: 'Fine' }))
        .status,
    ).toBe(200);
  });

  it('lets an admin through for governance', async () => {
    const s = await setup();
    expect(
      (await request(app).patch(`/api/tasks/${s.taskId}`).set(auth(s.admin.token)).send({ title: 'Admin edit' }))
        .status,
    ).toBe(200);
  });

  it('keeps invisible projects at 404, not 403', async () => {
    const owner = await makeUser(app, { email: 'privown@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'outsider@flowerstore.ph' });
    const priv = await request(app)
      .post('/api/projects')
      .set(auth(owner.token))
      .send({ name: 'Private', isPrivate: true });
    const id = priv.body.project.id;

    // A 403 here would confirm the project exists, which is the whole point of
    // the platform's invisibility rule.
    expect((await request(app).get(`/api/projects/${id}`).set(auth(outsider.token))).status).toBe(404);
    expect(
      (await request(app).patch(`/api/projects/${id}`).set(auth(outsider.token)).send({ name: 'x' })).status,
    ).toBe(404);
  });

  it('requires membership to convert a note into a project doc', async () => {
    const s = await setup();
    const note = await request(app)
      .post('/api/notes')
      .set(auth(s.visitor.token))
      .send({ title: 'Mine', content: 'x' });

    // Visible project, so this is the members-only rule rather than invisibility.
    const res = await request(app)
      .post(`/api/notes/${note.body.note.id}/convert-to-doc`)
      .set(auth(s.visitor.token))
      .send({ projectId: s.projectId });
    expect(res.status).toBe(403);
  });
});
