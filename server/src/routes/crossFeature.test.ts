/**
 * Cross-feature paths — the seams between two features, where a guard used
 * everywhere else can quietly be missing.
 *
 * Both Part 0 bugs lived here and survived a full green suite, because each
 * per-feature test file exercises its own routes and nothing reaches across:
 * notes → projects, and DMs → users. These tests must fail if either fix is
 * reverted.
 */

import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db/index.js';
import { channels, docs, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` } as Record<string, string>);

async function countChannels(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(channels);
  return Number(row.n);
}

describe('notes -> projects: conversion cannot cross a visibility boundary', () => {
  beforeEach(resetDb);

  it('refuses to convert a note into a project the author cannot see', async () => {
    const owner = await makeUser(app, { email: 'owner@flowerstore.ph' });
    const stranger = await makeUser(app, { email: 'stranger@flowerstore.ph' });

    // A private project belonging to someone else.
    const priv = await request(app)
      .post('/api/projects')
      .set(auth(stranger.token))
      .send({ name: 'Strangers Only', isPrivate: true });
    expect(priv.status).toBe(201);

    const note = await request(app)
      .post('/api/notes')
      .set(auth(owner.token))
      .send({ title: 'Personal', content: 'salary numbers' });

    const res = await request(app)
      .post(`/api/notes/${note.body.note.id}/convert-to-doc`)
      .set(auth(owner.token))
      .send({ projectId: priv.body.project.id });

    // Invisible -> 404, never a 403 that would confirm the project exists.
    expect(res.status).toBe(404);
    expect(await db.select().from(docs)).toHaveLength(0);
  });

  it('leaves the note intact when the conversion is refused', async () => {
    const owner = await makeUser(app, { email: 'owner2@flowerstore.ph' });
    const stranger = await makeUser(app, { email: 'stranger2@flowerstore.ph' });
    const priv = await request(app)
      .post('/api/projects')
      .set(auth(stranger.token))
      .send({ name: 'Hidden', isPrivate: true });
    const note = await request(app)
      .post('/api/notes')
      .set(auth(owner.token))
      .send({ title: 'Keep me', content: 'still here' });

    await request(app)
      .post(`/api/notes/${note.body.note.id}/convert-to-doc`)
      .set(auth(owner.token))
      .send({ projectId: priv.body.project.id });

    const still = await request(app)
      .get(`/api/notes/${note.body.note.id}`)
      .set(auth(owner.token));
    expect(still.status).toBe(200);
    expect(still.body.note.title).toBe('Keep me');
  });

  it('still converts into a project the author can see', async () => {
    const owner = await makeUser(app, { email: 'owner3@flowerstore.ph' });
    const proj = await request(app)
      .post('/api/projects')
      .set(auth(owner.token))
      .send({ name: 'Mine', isPrivate: true });
    const note = await request(app)
      .post('/api/notes')
      .set(auth(owner.token))
      .send({ title: 'Convert me', content: 'body' });

    const res = await request(app)
      .post(`/api/notes/${note.body.note.id}/convert-to-doc`)
      .set(auth(owner.token))
      .send({ projectId: proj.body.project.id });

    expect(res.status).toBe(201);
    expect(res.body.doc.title).toBe('Convert me');
    // The note is consumed by a successful conversion.
    expect(
      (await request(app).get(`/api/notes/${note.body.note.id}`).set(auth(owner.token))).status,
    ).toBe(404);
  });

  it('lets an admin convert into any project', async () => {
    const admin = await makeUser(app, { email: 'admin@flowerstore.ph', admin: true });
    const other = await makeUser(app, { email: 'other@flowerstore.ph' });
    const priv = await request(app)
      .post('/api/projects')
      .set(auth(other.token))
      .send({ name: 'Theirs', isPrivate: true });
    const note = await request(app)
      .post('/api/notes')
      .set(auth(admin.token))
      .send({ title: 'Governance', content: 'x' });

    const res = await request(app)
      .post(`/api/notes/${note.body.note.id}/convert-to-doc`)
      .set(auth(admin.token))
      .send({ projectId: priv.body.project.id });
    expect(res.status).toBe(201);
  });
});

describe('DMs -> users: a DM is only ever created for a real, active pair', () => {
  beforeEach(resetDb);

  it('returns 404 for an unknown user and creates nothing', async () => {
    const me = await makeUser(app, { email: 'me@flowerstore.ph' });
    const before = await countChannels();

    const res = await request(app).post('/api/dms').set(auth(me.token)).send({ userId: 999_999 });

    // Used to be a 500 from a foreign-key violation, with the channel row
    // already committed and its dm_key burned.
    expect(res.status).toBe(404);
    expect(await countChannels()).toBe(before);
  });

  it('returns 404 for a deactivated user and creates nothing', async () => {
    const me = await makeUser(app, { email: 'me2@flowerstore.ph' });
    const gone = await makeUser(app, { email: 'gone@flowerstore.ph' });
    await db.update(users).set({ isActive: false }).where(eq(users.id, gone.userId));
    const before = await countChannels();

    const res = await request(app)
      .post('/api/dms')
      .set(auth(me.token))
      .send({ userId: gone.userId });

    expect(res.status).toBe(404);
    expect(await countChannels()).toBe(before);
  });

  it('refuses a DM with yourself', async () => {
    const me = await makeUser(app, { email: 'me3@flowerstore.ph' });
    const res = await request(app).post('/api/dms').set(auth(me.token)).send({ userId: me.userId });
    expect(res.status).toBe(400);
  });

  it('creates one DM per pair, with both people in it, and is idempotent', async () => {
    const a = await makeUser(app, { email: 'a@flowerstore.ph' });
    const b = await makeUser(app, { email: 'b@flowerstore.ph' });

    const first = await request(app).post('/api/dms').set(auth(a.token)).send({ userId: b.userId });
    expect(first.status).toBe(201);
    const dmId = first.body.channel.id;

    // Same pair, opened from the other side: same channel, not a second one.
    const second = await request(app).post('/api/dms').set(auth(b.token)).send({ userId: a.userId });
    expect(second.body.channel.id).toBe(dmId);

    // Both sides are members, so both can list it and post in it.
    for (const who of [a, b]) {
      const list = await request(app).get('/api/dms').set(auth(who.token));
      expect(list.body.dms.map((d: { id: number }) => d.id)).toContain(dmId);
      expect(
        (await request(app).post(`/api/channels/${dmId}/messages`).set(auth(who.token)).send({ body: 'hi' }))
          .status,
      ).toBe(201);
    }
  });

  it('names the person on the other side, and counts unread', async () => {
    // The sidebar needs both. A DM has no name of its own, and the client should
    // not have to parse dm_key to find out who it is talking to.
    const a = await makeUser(app, { email: 'ann@flowerstore.ph' });
    const b = await makeUser(app, { email: 'ben@flowerstore.ph' });
    const dm = await request(app).post('/api/dms').set(auth(a.token)).send({ userId: b.userId });
    const dmId = dm.body.channel.id;

    let mine = await request(app).get('/api/dms').set(auth(a.token));
    expect(mine.body.dms).toHaveLength(1);
    expect(mine.body.dms[0].user.id).toBe(b.userId);
    expect(mine.body.dms[0].user.displayName).toBe('ben');
    expect(mine.body.dms[0].unreadCount).toBe(0);

    // Each side sees the *other* person, not themselves.
    const theirs = await request(app).get('/api/dms').set(auth(b.token));
    expect(theirs.body.dms[0].user.id).toBe(a.userId);

    await request(app).post(`/api/channels/${dmId}/messages`).set(auth(b.token)).send({ body: 'hi' });
    await request(app).post(`/api/channels/${dmId}/messages`).set(auth(b.token)).send({ body: 'there' });

    mine = await request(app).get('/api/dms').set(auth(a.token));
    expect(mine.body.dms[0].unreadCount).toBe(2);
  });

  it('keeps a DM out of the channel list and away from outsiders', async () => {
    const a = await makeUser(app, { email: 'a2@flowerstore.ph' });
    const b = await makeUser(app, { email: 'b2@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'out@flowerstore.ph' });
    const dm = await request(app).post('/api/dms').set(auth(a.token)).send({ userId: b.userId });
    const dmId = dm.body.channel.id;

    // DMs are not browsable channels.
    const channelList = await request(app).get('/api/channels').set(auth(a.token));
    expect(channelList.body.channels.map((c: { id: number }) => c.id)).not.toContain(dmId);

    // And a third party cannot see or read one.
    expect((await request(app).get(`/api/channels/${dmId}`).set(auth(outsider.token))).status).toBe(404);
    expect(
      (await request(app).get(`/api/channels/${dmId}/messages`).set(auth(outsider.token))).status,
    ).toBe(404);
  });
});

describe('projects -> tasks/docs: a non-member of a public project', () => {
  beforeEach(resetDb);

  it('can see the project and its board', async () => {
    const owner = await makeUser(app, { email: 'powner@flowerstore.ph' });
    const visitor = await makeUser(app, { email: 'visitor@flowerstore.ph' });
    const proj = await request(app)
      .post('/api/projects')
      .set(auth(owner.token))
      .send({ name: 'Open', isPrivate: false });
    const projectId = proj.body.project.id;

    expect((await request(app).get(`/api/projects/${projectId}`).set(auth(visitor.token))).status).toBe(200);
    const board = await request(app).get(`/api/projects/${projectId}/board`).set(auth(visitor.token));
    expect(board.status).toBe(200);
    expect(board.body.columns).toHaveLength(3);
  });
});
