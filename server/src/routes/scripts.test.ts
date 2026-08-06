/**
 * Scripts and the runner's door — Phase 10, server side.
 *
 * The runner itself is exercised for real (a Python child process, a timeout, a
 * memory cap) by running the service; what belongs here is the part the API owns:
 * who may create and run a script, that nothing executes in this process, and
 * that a run's credential is scoped, short-lived, and revoked when it finishes.
 */

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import { apiTokens, scriptRuns } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { ensureBotUser } from '../services/botService.js';
import { claimNextRun, finishRun, queueRun } from '../services/scriptService.js';
import { makeUser } from '../testHelpers.js';

// hoisted: a vi.mock factory runs before module-level consts exist.
const RUNNER_TOKEN = vi.hoisted(() => 'test-runner-secret-0123456789abcdef');
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { config: { ...actual.config, RUNNER_TOKEN } };
});

const { createApp } = await import('../app.js');
const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` }) as Record<string, string>;
const asRunner = { 'x-runner-token': RUNNER_TOKEN } as Record<string, string>;

async function makeScript(token: string, body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/scripts')
    .set(auth(token))
    .send({ name: 'Nightly', source: 'print("hi")', scopes: ['tickets:write'], ...body });
  expect(res.status).toBe(201);
  return res.body.script.id as number;
}

describe('scripts are admin-only', () => {
  beforeEach(resetDb);

  it('refuses a non-admin everywhere, without confirming anything exists', async () => {
    const admin = await makeUser(app, { email: 'sc-admin@flowerstore.ph', admin: true });
    const member = await makeUser(app, { email: 'sc-member@flowerstore.ph' });
    const scriptId = await makeScript(admin.token);

    // 404 rather than 403: writing a script is the ability to act as the
    // platform, so its existence is not something to advertise.
    expect((await request(app).get('/api/scripts').set(auth(member.token))).status).toBe(404);
    expect((await request(app).get(`/api/scripts/${scriptId}`).set(auth(member.token))).status).toBe(404);
    expect(
      (await request(app).post(`/api/scripts/${scriptId}/run`).set(auth(member.token))).status,
    ).toBe(404);
  });

  it('refuses a service token even with every scope', async () => {
    // An agent that could write its own privileged script would route around
    // its own scopes entirely.
    const admin = await makeUser(app, { email: 'sc-admin2@flowerstore.ph', admin: true });
    await ensureBotUser();
    const botId = (await request(app).get('/api/admin/users').set(auth(admin.token))).body.users.find(
      (u: { isBot: boolean; id: number }) => u.isBot,
    ).id;
    const token = await request(app)
      .post('/api/admin/tokens')
      .set(auth(admin.token))
      .send({ name: 'agent', scopes: ['tickets:write', 'docs:write'], actsAsUserId: botId });
    expect(token.status).toBe(201);

    const res = await request(app).get('/api/scripts').set(auth(token.body.token));
    expect(res.status).toBe(401);
  });
});

describe('running a script', () => {
  beforeEach(async () => {
    await resetDb();
    await ensureBotUser();
  });

  it('queues rather than executes', async () => {
    const admin = await makeUser(app, { email: 'sc-run@flowerstore.ph', admin: true });
    const scriptId = await makeScript(admin.token);

    const res = await request(app).post(`/api/scripts/${scriptId}/run`).set(auth(admin.token));
    // 202: accepted, not done. Nothing in this process ever runs user code.
    expect(res.status).toBe(202);
    expect(res.body.run.status).toBe('queued');

    const runs = await request(app).get(`/api/scripts/${scriptId}/runs`).set(auth(admin.token));
    expect(runs.body.runs).toHaveLength(1);
  });

  it('hands the runner the source and a token holding only the script scopes', async () => {
    const admin = await makeUser(app, { email: 'sc-run2@flowerstore.ph', admin: true });
    const scriptId = await makeScript(admin.token, { scopes: ['tickets:read'] });
    await request(app).post(`/api/scripts/${scriptId}/run`).set(auth(admin.token));

    const claim = await request(app).post('/api/runner/claim').set(asRunner);
    expect(claim.status).toBe(200);
    expect(claim.body.script.source).toBe('print("hi")');
    expect(claim.body.token).toMatch(/\S+/);

    const [minted] = await db.select().from(apiTokens);
    expect(minted.scopes).toEqual(['tickets:read']);
    // Short-lived: a leaked token from a crashed run is worthless within minutes.
    expect(minted.expiresAt).not.toBeNull();
    expect(minted.revokedAt).toBeNull();
  });

  it('revokes the run token when the run finishes', async () => {
    const admin = await makeUser(app, { email: 'sc-run3@flowerstore.ph', admin: true });
    const scriptId = await makeScript(admin.token);
    await request(app).post(`/api/scripts/${scriptId}/run`).set(auth(admin.token));
    const claim = await request(app).post('/api/runner/claim').set(asRunner);

    const finish = await request(app)
      .post(`/api/runner/runs/${claim.body.run.id}/finish`)
      .set(asRunner)
      .send({ status: 'succeeded', exitCode: 0, stdout: 'hi\n' });
    expect(finish.status).toBe(200);

    const [token] = await db.select().from(apiTokens);
    // The credential dies with the run — otherwise it is a standing key with
    // that script's scopes and nobody watching it.
    expect(token.revokedAt).not.toBeNull();

    const run = await request(app).get(`/api/script-runs/${claim.body.run.id}`).set(auth(admin.token));
    expect(run.body.run.status).toBe('succeeded');
    expect(run.body.run.stdout).toBe('hi\n');
  });

  it('records a timeout as its own status, not as a failure', async () => {
    const admin = await makeUser(app, { email: 'sc-run4@flowerstore.ph', admin: true });
    const scriptId = await makeScript(admin.token);
    const run = await queueRun(scriptId, admin.userId);
    await finishRun(run.id, { status: 'timeout', stderr: 'Killed after 60s' });

    const [row] = await db.select().from(scriptRuns).where(eq(scriptRuns.id, run.id));
    // A runaway and a bug read differently in a run history.
    expect(row.status).toBe('timeout');
  });

  it('gives the same run to only one runner', async () => {
    const admin = await makeUser(app, { email: 'sc-run5@flowerstore.ph', admin: true });
    const scriptId = await makeScript(admin.token);
    await queueRun(scriptId, admin.userId);

    // Two runners racing: exactly one may win, or a script that files tickets
    // files everything twice.
    const [first, second] = await Promise.all([claimNextRun(), claimNextRun()]);
    const claimed = [first, second].filter(Boolean);
    expect(claimed).toHaveLength(1);
  });

  it('returns 204 when the queue is empty, so the poll loop stays cheap', async () => {
    expect((await request(app).post('/api/runner/claim').set(asRunner)).status).toBe(204);
  });
});

describe('the runner door', () => {
  beforeEach(resetDb);

  it('refuses a missing or wrong secret', async () => {
    expect((await request(app).post('/api/runner/claim')).status).toBe(401);
    expect(
      (await request(app).post('/api/runner/claim').set({ 'x-runner-token': 'wrong' })).status,
    ).toBe(401);
  });

  it('refuses a user JWT — the runner is infrastructure, not an actor', async () => {
    const admin = await makeUser(app, { email: 'sc-door@flowerstore.ph', admin: true });
    expect((await request(app).post('/api/runner/claim').set(auth(admin.token))).status).toBe(401);
  });
});
