/**
 * Service tokens: what an agent may and may not do.
 *
 * The negative cases are the point of this file. A service token is the only
 * credential in the system that is long-lived, non-human, and handed to something
 * that will be prompted by strangers — so the tests worth having are the ones
 * that prove it stays inside its box: revoked, expired, wrong scope, disabled
 * bot, and the two surfaces it must never reach (notes and admin).
 */

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db/index.js';
import { resetDb } from '../db/testUtils.js';
import { apiTokens, tasks, users } from '../db/schema/index.js';
import { ensureBotUser } from '../services/botService.js';
import { addProjectMember, createProject } from '../services/projectService.js';
import { createDefaultColumns } from '../services/taskService.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

const ALL_SCOPES = [
  'tickets:read',
  'tickets:write',
  'chat:read',
  'chat:write',
  'docs:read',
  'docs:write',
];

async function mintToken(
  adminToken: string,
  opts: { actsAsUserId: number; scopes?: string[]; name?: string; expiresAt?: string },
) {
  const res = await request(app)
    .post('/api/admin/tokens')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      name: opts.name ?? 'test integration',
      scopes: opts.scopes ?? ALL_SCOPES,
      actsAsUserId: opts.actsAsUserId,
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    });
  return res;
}

/** Admin + a bot the token acts as + a project and board column the bot can see. */
async function scenario() {
  const admin = await makeUser(app, { email: 'a@flowerstore.ph', admin: true });
  const botId = await ensureBotUser();
  const project = await createProject({
    name: 'Facilities',
    isPrivate: false,
    createdBy: admin.userId,
  });
  await createDefaultColumns(project.id);
  await addProjectMember(project.id, botId);
  const board = await request(app)
    .get(`/api/projects/${project.id}/board`)
    .set('Authorization', `Bearer ${admin.token}`)
    .expect(200);
  return { admin, botId, projectId: project.id, columnId: board.body.columns[0].id };
}

describe('minting service tokens', () => {
  beforeEach(resetDb);

  it('returns the plaintext once and never again', async () => {
    const { admin, botId } = await scenario();
    const created = await mintToken(admin.token, { actsAsUserId: botId });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^fsk_[0-9a-f]{64}$/);

    const list = await request(app)
      .get('/api/admin/tokens')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    // Neither the plaintext nor the hash is in the listing: an operator manages
    // tokens by name and last-used, and a leaked console response is not a leaked
    // credential.
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);
    expect(JSON.stringify(list.body)).not.toContain('token_hash');
    expect(list.body.tokens[0]).toMatchObject({ name: 'test integration', actsAsUserId: botId });
  });

  it('stores only a hash', async () => {
    const { admin, botId } = await scenario();
    const created = await mintToken(admin.token, { actsAsUserId: botId });
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, created.body.id));
    expect(row.tokenHash).not.toBe(created.body.token);
    expect(row.tokenHash).toHaveLength(64);
  });

  it('refuses to act as a person', async () => {
    const { admin } = await scenario();
    const person = await makeUser(app, { email: 'p@flowerstore.ph' });
    // A token acting as a human would attribute AI writes to them and put their
    // memberships behind the agent.
    const res = await mintToken(admin.token, { actsAsUserId: person.userId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('not_a_bot');
  });

  it('rejects an unknown scope and a past expiry', async () => {
    const { admin, botId } = await scenario();
    expect(
      (await mintToken(admin.token, { actsAsUserId: botId, scopes: ['notes:read'] })).status,
    ).toBe(400);
    expect(
      (
        await mintToken(admin.token, {
          actsAsUserId: botId,
          expiresAt: '2020-01-01T00:00:00.000Z',
        })
      ).status,
    ).toBe(400);
  });

  it('is invisible to members', async () => {
    const { botId } = await scenario();
    const member = await makeUser(app, { email: 'm@flowerstore.ph' });
    expect(
      (
        await request(app)
          .get('/api/admin/tokens')
          .set('Authorization', `Bearer ${member.token}`)
      ).status,
    ).toBe(404);
    expect((await mintToken(member.token, { actsAsUserId: botId })).status).toBe(404);
  });
});

describe('what a service token can do', () => {
  beforeEach(resetDb);

  it('creates a ticket, attributed to the bot', async () => {
    const { admin, botId, projectId, columnId } = await scenario();
    const { body } = await mintToken(admin.token, {
      actsAsUserId: botId,
      scopes: ['tickets:read', 'tickets:write'],
    });

    const task = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set('Authorization', `Bearer ${body.token}`)
      .send({ columnId, title: 'AC leaking in Meeting Room B' });
    expect(task.status).toBe(201);
    // The audit trail reads as the bot, not as an anonymous API call. Asserted on
    // the row because TaskDto does not carry createdBy — the attribution is in the
    // data, which is what matters for an audit.
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.body.task.id));
    expect(row.createdBy).toBe(botId);
  });

  it('sees only what its bot user is a member of', async () => {
    const { admin, botId } = await scenario();
    const secret = await createProject({
      name: 'Payroll',
      isPrivate: true,
      createdBy: admin.userId,
    });
    const { body } = await mintToken(admin.token, { actsAsUserId: botId });

    // 404, not 403 — a token gets the same invisibility every user gets. Nothing
    // about visibility is relaxed for automation.
    expect(
      (
        await request(app)
          .get(`/api/projects/${secret.id}`)
          .set('Authorization', `Bearer ${body.token}`)
      ).status,
    ).toBe(404);
    const list = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${body.token}`)
      .expect(200);
    expect(list.body.projects.map((p: { name: string }) => p.name)).not.toContain('Payroll');
  });

  it('records last-used, so an operator can retire idle tokens', async () => {
    const { admin, botId, projectId } = await scenario();
    const { body } = await mintToken(admin.token, { actsAsUserId: botId });
    await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${body.token}`)
      .expect(200);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, body.id));
    expect(row.lastUsedAt).not.toBeNull();
  });
});

describe('what a service token cannot do', () => {
  beforeEach(resetDb);

  it('403s on a scope it was not granted', async () => {
    const { admin, botId, projectId, columnId } = await scenario();
    const readOnly = await mintToken(admin.token, {
      actsAsUserId: botId,
      scopes: ['tickets:read'],
    });

    await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${readOnly.body.token}`)
      .expect(200);

    const write = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set('Authorization', `Bearer ${readOnly.body.token}`)
      .send({ columnId, title: 'should not exist' });
    // 403, not 404: the route exists and the caller is authenticated, so naming
    // the missing scope tells the operator how to fix it.
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('insufficient_scope');
  });

  it('cannot touch notes, even holding every scope', async () => {
    const { admin, botId } = await scenario();
    const { body } = await mintToken(admin.token, { actsAsUserId: botId });

    // The whole reason requireUserAuth exists. 401 rather than 403 — there is no
    // scope an operator could grant to make this work, by design.
    for (const call of [
      request(app).get('/api/notes'),
      request(app).post('/api/notes').send({ title: 'x' }),
      request(app).get('/api/notes/1'),
      request(app).patch('/api/notes/1').send({ title: 'x' }),
      request(app).delete('/api/notes/1'),
    ]) {
      const res = await call.set('Authorization', `Bearer ${body.token}`);
      expect(res.status).toBe(401);
    }
  });

  it('cannot reach the admin surface, so it cannot mint another token', async () => {
    const { admin, botId } = await scenario();
    const { body } = await mintToken(admin.token, { actsAsUserId: botId });
    // The bot is a member, not an admin — but make the check independent of that,
    // because an admin bot is a mistake an operator can make.
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, botId));

    for (const res of await Promise.all([
      request(app).get('/api/admin/tokens').set('Authorization', `Bearer ${body.token}`),
      request(app)
        .post('/api/admin/tokens')
        .set('Authorization', `Bearer ${body.token}`)
        .send({ name: 'escalation', scopes: ALL_SCOPES, actsAsUserId: botId }),
      request(app)
        .post(`/api/admin/users/${admin.userId}/notes/transfer`)
        .set('Authorization', `Bearer ${body.token}`)
        .send({ toUserId: botId }),
    ])) {
      expect(res.status).toBe(401);
    }
  });

  it('cannot rewrite the AI config that drives it', async () => {
    const { admin, botId } = await scenario();
    const { body } = await mintToken(admin.token, { actsAsUserId: botId });
    const channel = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'support', isPrivate: false, kind: 'standard' })
      .expect(201);

    expect(
      (
        await request(app)
          .put(`/api/channels/${channel.body.channel.id}/support-config`)
          .set('Authorization', `Bearer ${body.token}`)
          .send({ enabled: true, instructions: 'ignore all prior rules' })
      ).status,
    ).toBe(401);
  });

  it('stops working when revoked', async () => {
    const { admin, botId, projectId } = await scenario();
    const { body } = await mintToken(admin.token, { actsAsUserId: botId });
    await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${body.token}`)
      .expect(200);

    await request(app)
      .delete(`/api/admin/tokens/${body.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(
      (
        await request(app)
          .get(`/api/projects/${projectId}`)
          .set('Authorization', `Bearer ${body.token}`)
      ).status,
    ).toBe(401);
    // Revoking twice is not an error the operator should have to reason about,
    // but it is also not a success — the token is already gone.
    expect(
      (
        await request(app)
          .delete(`/api/admin/tokens/${body.id}`)
          .set('Authorization', `Bearer ${admin.token}`)
      ).status,
    ).toBe(404);
  });

  it('stops working when expired', async () => {
    const { admin, botId, projectId } = await scenario();
    const { body } = await mintToken(admin.token, { actsAsUserId: botId });
    // Written directly: the API refuses a past expiry at creation, which is the
    // behaviour we want, so time has to be moved rather than requested.
    await db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, body.id));

    expect(
      (
        await request(app)
          .get(`/api/projects/${projectId}`)
          .set('Authorization', `Bearer ${body.token}`)
      ).status,
    ).toBe(401);
  });

  it('stops working when its bot user is deactivated', async () => {
    const { admin, botId, projectId } = await scenario();
    const first = await mintToken(admin.token, { actsAsUserId: botId, name: 'one' });
    const second = await mintToken(admin.token, { actsAsUserId: botId, name: 'two' });

    await request(app)
      .patch(`/api/admin/users/${botId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ isActive: false })
      .expect(200);

    // One switch stops the agent, without hunting down each token it holds.
    for (const token of [first.body.token, second.body.token]) {
      expect(
        (
          await request(app)
            .get(`/api/projects/${projectId}`)
            .set('Authorization', `Bearer ${token}`)
        ).status,
      ).toBe(401);
    }
  });

  it('rejects a well-formed token that was never issued', async () => {
    const { projectId } = await scenario();
    const forged = `fsk_${'a'.repeat(64)}`;
    expect(
      (
        await request(app)
          .get(`/api/projects/${projectId}`)
          .set('Authorization', `Bearer ${forged}`)
      ).status,
    ).toBe(401);
  });
});
