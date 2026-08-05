/**
 * Offboarding: handing a departing colleague's notes to someone else.
 *
 * Notes are private to their owner, so when someone leaves, their notes become
 * unreachable — and deleting the account would cascade them away for good. The
 * transfer exists for that, and the property worth protecting is that it moves
 * ownership *without* giving the admin who runs it any way to read notes.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` } as Record<string, string>);

async function scenario() {
  const admin = await makeUser(app, { email: 'boss@flowerstore.ph', admin: true });
  const leaver = await makeUser(app, { email: 'leaver@flowerstore.ph' });
  const manager = await makeUser(app, { email: 'manager@flowerstore.ph' });

  const titles = ['Handover', 'Passwords rotated', 'Q3 retro'];
  const ids: number[] = [];
  for (const title of titles) {
    const res = await request(app)
      .post('/api/notes')
      .set(auth(leaver.token))
      .send({ title, content: `${title} body` });
    ids.push(res.body.note.id);
  }
  return { admin, leaver, manager, ids, titles };
}

describe('note ownership transfer', () => {
  beforeEach(resetDb);

  it('moves every note to the new owner', async () => {
    const s = await scenario();

    const res = await request(app)
      .post(`/api/admin/users/${s.leaver.userId}/notes/transfer`)
      .set(auth(s.admin.token))
      .send({ toUserId: s.manager.userId });

    expect(res.status).toBe(200);
    expect(res.body.transferred).toBe(3);

    // The manager now owns them and can open them.
    const theirs = await request(app).get('/api/notes').set(auth(s.manager.token));
    expect(theirs.body.notes.map((n: { title: string }) => n.title).sort()).toEqual(
      [...s.titles].sort(),
    );
    expect(
      (await request(app).get(`/api/notes/${s.ids[0]}`).set(auth(s.manager.token))).status,
    ).toBe(200);

    // The previous owner no longer does.
    const gone = await request(app).get('/api/notes').set(auth(s.leaver.token));
    expect(gone.body.notes).toHaveLength(0);
    expect((await request(app).get(`/api/notes/${s.ids[0]}`).set(auth(s.leaver.token))).status).toBe(
      404,
    );
  });

  it('does not let the admin read the notes it can move', async () => {
    // The whole point: rescuing someone's notes must not become a way to read
    // everyone's. There is no admin path to note content, before or after.
    const s = await scenario();

    expect((await request(app).get('/api/notes').set(auth(s.admin.token))).body.notes).toHaveLength(0);
    expect((await request(app).get(`/api/notes/${s.ids[0]}`).set(auth(s.admin.token))).status).toBe(404);

    await request(app)
      .post(`/api/admin/users/${s.leaver.userId}/notes/transfer`)
      .set(auth(s.admin.token))
      .send({ toUserId: s.manager.userId });

    expect((await request(app).get(`/api/notes/${s.ids[0]}`).set(auth(s.admin.token))).status).toBe(404);
    // The response is a count, not content.
    const count = await request(app)
      .get(`/api/admin/users/${s.manager.userId}/notes/count`)
      .set(auth(s.admin.token));
    expect(count.body).toEqual({ count: 3 });
  });

  it('is invisible to non-admins', async () => {
    const s = await scenario();
    // 404 rather than 403 — the admin surface does not admit it exists.
    expect(
      (
        await request(app)
          .post(`/api/admin/users/${s.leaver.userId}/notes/transfer`)
          .set(auth(s.leaver.token))
          .send({ toUserId: s.leaver.userId })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/admin/users/${s.leaver.userId}/notes/count`).set(auth(s.manager.token)))
        .status,
    ).toBe(404);
  });

  it('refuses a destination that cannot use them', async () => {
    const s = await scenario();
    const t = (toUserId: number) =>
      request(app)
        .post(`/api/admin/users/${s.leaver.userId}/notes/transfer`)
        .set(auth(s.admin.token))
        .send({ toUserId });

    expect((await t(999_999)).status).toBe(404); // nobody
    expect((await t(s.leaver.userId)).status).toBe(400); // themselves

    // A deactivated destination would put the notes right back out of reach.
    await request(app)
      .patch(`/api/admin/users/${s.manager.userId}`)
      .set(auth(s.admin.token))
      .send({ isActive: false });
    expect((await t(s.manager.userId)).status).toBe(404);
  });

  it('works after the leaver is deactivated, which is the real sequence', async () => {
    const s = await scenario();
    await request(app)
      .patch(`/api/admin/users/${s.leaver.userId}`)
      .set(auth(s.admin.token))
      .send({ isActive: false });

    const res = await request(app)
      .post(`/api/admin/users/${s.leaver.userId}/notes/transfer`)
      .set(auth(s.admin.token))
      .send({ toUserId: s.manager.userId });
    expect(res.status).toBe(200);
    expect(res.body.transferred).toBe(3);
  });

  it('reports zero for someone with no notes rather than failing', async () => {
    const s = await scenario();
    const res = await request(app)
      .post(`/api/admin/users/${s.manager.userId}/notes/transfer`)
      .set(auth(s.admin.token))
      .send({ toUserId: s.leaver.userId });
    expect(res.status).toBe(200);
    expect(res.body.transferred).toBe(0);
  });
});
