/**
 * Native spreadsheets — Phase 9, step 4 (server side).
 *
 * Two things carry the weight here: a sheet has no visibility of its own and must
 * answer to its project's, and the edit lock has to actually stop a second writer
 * — otherwise "single editor" is a label rather than a guarantee.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { acquireLock, canWrite, getLock, releaseAllFor, releaseLock } from '../services/sheetService.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` }) as Record<string, string>;

const SNAPSHOT = JSON.stringify({ id: 'wb1', sheetOrder: ['s1'], sheets: { s1: { name: 'Sheet1' } } });

async function makeProject(token: string, name: string, isPrivate = false) {
  const res = await request(app).post('/api/projects').set(auth(token)).send({ name, isPrivate });
  expect(res.status).toBe(201);
  return res.body.project.id as number;
}

async function makeSheet(token: string, projectId: number, title = 'Budget') {
  const res = await request(app)
    .post(`/api/projects/${projectId}/sheets`)
    .set(auth(token))
    .send({ title });
  expect(res.status).toBe(201);
  return res.body.sheet.id as number;
}

describe('sheets follow their project', () => {
  beforeEach(resetDb);

  it('creates, lists and reads a sheet', async () => {
    const owner = await makeUser(app, { email: 'sh-owner@flowerstore.ph' });
    const projectId = await makeProject(owner.token, 'Finance');
    const sheetId = await makeSheet(owner.token, projectId, 'Q3 budget');

    const list = await request(app).get(`/api/projects/${projectId}/sheets`).set(auth(owner.token));
    expect(list.status).toBe(200);
    expect(list.body.sheets).toHaveLength(1);
    expect(list.body.sheets[0].title).toBe('Q3 budget');
    // The list must not carry snapshots — they are megabytes each.
    expect(list.body.sheets[0].data).toBeUndefined();

    const one = await request(app).get(`/api/sheets/${sheetId}`).set(auth(owner.token));
    expect(one.status).toBe(200);
    expect(one.body.sheet.data).toBe(''); // never saved yet
    expect(one.body.lock).toBeNull();
  });

  it('404s a sheet in a private project for an outsider', async () => {
    const owner = await makeUser(app, { email: 'sh-owner2@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'sh-out@flowerstore.ph' });
    const projectId = await makeProject(owner.token, 'Secret plans', true);
    const sheetId = await makeSheet(owner.token, projectId);

    expect((await request(app).get(`/api/sheets/${sheetId}`).set(auth(outsider.token))).status).toBe(404);
    expect(
      (await request(app).get(`/api/projects/${projectId}/sheets`).set(auth(outsider.token))).status,
    ).toBe(404);
  });

  it('403s a non-member who can see a public project', async () => {
    const owner = await makeUser(app, { email: 'sh-owner3@flowerstore.ph' });
    const viewer = await makeUser(app, { email: 'sh-viewer@flowerstore.ph' });
    const projectId = await makeProject(owner.token, 'Open project');
    const sheetId = await makeSheet(owner.token, projectId);

    // Visible, so reading is fine…
    expect((await request(app).get(`/api/sheets/${sheetId}`).set(auth(viewer.token))).status).toBe(200);
    // …but changing it is members-only, and 403 is right once it is known visible.
    const res = await request(app)
      .patch(`/api/sheets/${sheetId}`)
      .set(auth(viewer.token))
      .send({ title: 'Renamed by a stranger' });
    expect(res.status).toBe(403);
  });

  it('saves a workbook snapshot and refuses one that is not JSON', async () => {
    const owner = await makeUser(app, { email: 'sh-owner4@flowerstore.ph' });
    const projectId = await makeProject(owner.token, 'Modelling');
    const sheetId = await makeSheet(owner.token, projectId);

    const good = await request(app)
      .patch(`/api/sheets/${sheetId}`)
      .set(auth(owner.token))
      .send({ data: SNAPSHOT });
    expect(good.status).toBe(200);

    const fetched = await request(app).get(`/api/sheets/${sheetId}`).set(auth(owner.token));
    expect(JSON.parse(fetched.body.sheet.data).sheetOrder).toEqual(['s1']);

    const bad = await request(app)
      .patch(`/api/sheets/${sheetId}`)
      .set(auth(owner.token))
      .send({ data: 'not a workbook' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_snapshot');
  });

  it('deletes a sheet', async () => {
    const owner = await makeUser(app, { email: 'sh-owner5@flowerstore.ph' });
    const projectId = await makeProject(owner.token, 'Temporary');
    const sheetId = await makeSheet(owner.token, projectId);

    expect((await request(app).delete(`/api/sheets/${sheetId}`).set(auth(owner.token))).status).toBe(200);
    expect((await request(app).get(`/api/sheets/${sheetId}`).set(auth(owner.token))).status).toBe(404);
  });
});

describe('the edit lock', () => {
  beforeEach(resetDb);

  it('stops a second member saving over the holder', async () => {
    const owner = await makeUser(app, { email: 'lk-owner@flowerstore.ph' });
    const admin = await makeUser(app, { email: 'lk-admin@flowerstore.ph', admin: true });
    const projectId = await makeProject(owner.token, 'Shared model');
    const sheetId = await makeSheet(owner.token, projectId);

    // The owner takes the lock (over a socket in real life; directly here).
    acquireLock(sheetId, { userId: owner.userId, displayName: 'Owner', socketId: 'socket-a' });

    const blocked = await request(app)
      .patch(`/api/sheets/${sheetId}`)
      .set(auth(admin.token))
      .send({ data: SNAPSHOT });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('sheet_locked');
    // The message names who is holding it — otherwise the only recourse is to guess.
    expect(blocked.body.error.message).toContain('Owner');

    // The holder still can.
    const allowed = await request(app)
      .patch(`/api/sheets/${sheetId}`)
      .set(auth(owner.token))
      .send({ data: SNAPSHOT });
    expect(allowed.status).toBe(200);
  });

  it('frees the sheet when the holder disconnects', async () => {
    const owner = await makeUser(app, { email: 'lk-owner2@flowerstore.ph' });
    const other = await makeUser(app, { email: 'lk-other@flowerstore.ph', admin: true });
    const projectId = await makeProject(owner.token, 'Handover');
    const sheetId = await makeSheet(owner.token, projectId);

    acquireLock(sheetId, { userId: owner.userId, displayName: 'Owner', socketId: 'socket-a' });
    expect(
      (await request(app).patch(`/api/sheets/${sheetId}`).set(auth(other.token)).send({ title: 'x' }))
        .status,
    ).toBe(409);

    // A closed tab is the only signal that an editor left — this is why the lock
    // is held on the socket and not in a row.
    expect(releaseAllFor('socket-a')).toEqual([sheetId]);

    expect(
      (await request(app).patch(`/api/sheets/${sheetId}`).set(auth(other.token)).send({ title: 'x' }))
        .status,
    ).toBe(200);
  });

  it('refuses to hand the lock to a second socket, and lets the holder re-acquire', () => {
    const first = acquireLock(1, { userId: 1, displayName: 'A', socketId: 'socket-a' });
    expect(first.ok).toBe(true);

    const second = acquireLock(1, { userId: 2, displayName: 'B', socketId: 'socket-b' });
    expect(second.ok).toBe(false);
    expect(second.lock.displayName).toBe('A'); // reports the holder, so the UI can name them

    // Re-acquiring your own lock must not deadlock you out of your own sheet.
    expect(acquireLock(1, { userId: 1, displayName: 'A', socketId: 'socket-a' }).ok).toBe(true);
  });

  it('only lets the holding socket release it', () => {
    acquireLock(2, { userId: 1, displayName: 'A', socketId: 'socket-a' });
    expect(releaseLock(2, 'socket-b')).toBe(false);
    expect(getLock(2)).not.toBeNull();
    expect(releaseLock(2, 'socket-a')).toBe(true);
    expect(getLock(2)).toBeNull();
  });

  it('treats an unlocked sheet as writable by anyone', () => {
    expect(canWrite(99, 1)).toBe(true);
  });
});
