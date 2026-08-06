/**
 * AI Routines — Phase 11.
 *
 * A routine acts with nobody watching, so the properties worth pinning are the
 * boundaries: a routine cannot use a tool it lacks the scope for, cannot aim its
 * output at a channel its owner cannot see, cannot be created by a service token,
 * and belongs to its owner. The model is stubbed — what is under test is the
 * loop and its limits, not Claude.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db/index.js';
import { messages } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { ensureBotUser, getBotUserId } from '../services/botService.js';
import { addChannelMember, createChannel } from '../services/channelService.js';
import { isValidSchedule, nextRunAt, scheduledCount } from '../services/routineScheduler.js';
import { setRoutineClient } from '../services/routineRunner.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` }) as Record<string, string>;

/**
 * A stand-in for Claude: replays a scripted list of responses, and records what
 * tools it was offered so a test can assert the scope filter actually applied.
 */
function stubClient(turns: unknown[]) {
  const offered: string[][] = [];
  let index = 0;
  return {
    offered,
    client: {
      messages: {
        create: async (params: { tools?: { name: string }[] }) => {
          offered.push((params.tools ?? []).map((t) => t.name));
          const turn = turns[Math.min(index++, turns.length - 1)];
          return turn;
        },
      },
    },
  };
}

const say = (text: string) => ({
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

const useTool = (name: string, input: Record<string, unknown>) => ({
  content: [{ type: 'tool_use', id: 'tu_1', name, input }],
  usage: { input_tokens: 20, output_tokens: 15 },
});

async function makeRoutine(token: string, body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/routines')
    .set(auth(token))
    .send({
      name: 'Morning digest',
      prompt: 'Summarise yesterday',
      // Every minute — the master plan's own example.
      schedule: '* * * * *',
      scopes: [],
      ...body,
    });
  expect(res.status).toBe(201);
  return res.body.routine;
}

describe('routine schedules', () => {
  beforeEach(resetDb);

  it('rejects a schedule the system cannot run', async () => {
    const user = await makeUser(app, { email: 'rt-sched@flowerstore.ph' });
    const res = await request(app)
      .post('/api/routines')
      .set(auth(user.token))
      .send({ name: 'Bad', prompt: 'x', schedule: 'not a cron', scopes: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_schedule');
  });

  it('reports when a routine will next run, and stops reporting once disabled', async () => {
    const user = await makeUser(app, { email: 'rt-sched2@flowerstore.ph' });
    const routine = await makeRoutine(user.token);
    expect(routine.nextRunAt).not.toBeNull();
    expect(scheduledCount()).toBeGreaterThan(0);

    const off = await request(app)
      .patch(`/api/routines/${routine.id}`)
      .set(auth(user.token))
      .send({ enabled: false });
    expect(off.body.routine.nextRunAt).toBeNull();
    // The kill switch has to disarm the timer, not just set a flag.
    expect(scheduledCount()).toBe(0);
  });

  it('validates and previews schedules the same way the routes do', () => {
    expect(isValidSchedule('* * * * *')).toBe(true);
    expect(isValidSchedule('0 8 * * 1-5')).toBe(true);
    expect(isValidSchedule('every morning')).toBe(false);
    expect(nextRunAt('0 8 * * *')).toBeInstanceOf(Date);
  });
});

describe('routine ownership', () => {
  beforeEach(resetDb);

  it("404s someone else's routine, and lets an admin see it", async () => {
    const owner = await makeUser(app, { email: 'rt-owner@flowerstore.ph' });
    const other = await makeUser(app, { email: 'rt-other@flowerstore.ph' });
    const admin = await makeUser(app, { email: 'rt-admin@flowerstore.ph', admin: true });
    const routine = await makeRoutine(owner.token);

    expect((await request(app).get(`/api/routines/${routine.id}`).set(auth(other.token))).status).toBe(404);
    expect((await request(app).get(`/api/routines/${routine.id}`).set(auth(admin.token))).status).toBe(200);
    expect((await request(app).get('/api/routines').set(auth(other.token))).body.routines).toHaveLength(0);
  });

  it('refuses an output channel the owner cannot see', async () => {
    const owner = await makeUser(app, { email: 'rt-owner2@flowerstore.ph' });
    const stranger = await makeUser(app, { email: 'rt-stranger@flowerstore.ph' });
    const secret = await createChannel({
      name: `secret${Date.now()}`,
      isPrivate: true,
      createdBy: stranger.userId,
    });

    // Otherwise a channel id alone would confirm a private channel exists, and
    // aim a routine's output into it.
    const res = await request(app)
      .post('/api/routines')
      .set(auth(owner.token))
      .send({ name: 'Leaky', prompt: 'x', schedule: '* * * * *', scopes: [], outputChannelId: secret.id });
    expect(res.status).toBe(404);
  });
});

describe('running a routine', () => {
  beforeEach(async () => {
    await resetDb();
    await ensureBotUser();
  });

  it('offers only the tools the routine holds scopes for', async () => {
    const user = await makeUser(app, { email: 'rt-scope@flowerstore.ph' });
    const routine = await makeRoutine(user.token, { scopes: ['tickets:read'] });
    const stub = stubClient([say('Nothing to do.')]);
    setRoutineClient(stub.client as never);

    const res = await request(app).post(`/api/routines/${routine.id}/run`).set(auth(user.token));
    expect(res.status).toBe(201);
    expect(res.body.run.status).toBe('succeeded');
    // tickets:read grants the whole read set from the shared registry — the same
    // verbs an MCP client gets — and nothing outside that scope.
    expect(stub.offered[0]).toEqual(['list_projects', 'list_tickets', 'get_ticket']);
    expect(stub.offered[0]).not.toContain('post_message');
    expect(stub.offered[0]).not.toContain('create_ticket');
  });

  it('refuses a tool the routine has no scope for, even if the model asks', async () => {
    const user = await makeUser(app, { email: 'rt-scope2@flowerstore.ph' });
    const channel = await createChannel({ name: `c${Date.now()}`, isPrivate: false, createdBy: user.userId });
    const routine = await makeRoutine(user.token, { scopes: ['tickets:read'] });

    const stub = stubClient([
      useTool('post_message', { channelId: channel.id, body: 'I should not be able to say this' }),
      say('Could not post.'),
    ]);
    setRoutineClient(stub.client as never);

    await request(app).post(`/api/routines/${routine.id}/run`).set(auth(user.token));

    // The scopes are the boundary; the prompt cannot talk past them.
    expect(await db.select().from(messages)).toHaveLength(0);
    const runs = await request(app).get(`/api/routines/${routine.id}/runs`).set(auth(user.token));
    const transcript = runs.body.runs[0].transcript as { type: string; output?: { error?: string } }[];
    const result = transcript.find((e) => e.type === 'tool_result');
    expect(result?.output?.error).toMatch(/No tool named post_message/);
  });

  it('posts as the bot when it does hold the scope, and records a readable transcript', async () => {
    const user = await makeUser(app, { email: 'rt-post@flowerstore.ph' });
    const channel = await createChannel({ name: `c${Date.now()}`, isPrivate: false, createdBy: user.userId });
    const botUserId = (await getBotUserId())!;
    // A routine acts as the bot, so the bot needs to be in the channel.
    await addChannelMember(channel.id, botUserId);
    const routine = await makeRoutine(user.token, { scopes: ['chat:write'] });

    const stub = stubClient([
      useTool('post_message', { channelId: channel.id, body: 'Good morning' }),
      say('Posted the digest.'),
    ]);
    setRoutineClient(stub.client as never);

    const res = await request(app).post(`/api/routines/${routine.id}/run`).set(auth(user.token));
    expect(res.body.run.status).toBe('succeeded');
    expect(res.body.run.summary).toBe('Posted the digest.');

    const [posted] = await db.select().from(messages);
    expect(posted.body).toBe('Good morning');
    // Attributed to the automation, never to whoever pressed Run.
    expect(posted.userId).toBe(botUserId);

    const transcript = res.body.run.transcript as { type: string; name?: string }[];
    expect(transcript.map((e) => e.type)).toEqual(['tool_use', 'tool_result', 'text']);
    expect(transcript[0].name).toBe('post_message');
  });

  it('stops as failed rather than looping forever', async () => {
    const user = await makeUser(app, { email: 'rt-loop@flowerstore.ph' });
    const routine = await makeRoutine(user.token, { scopes: ['tickets:read'] });
    // A model that always asks for another tool call would never finish.
    const stub = stubClient([useTool('list_tickets', { projectId: 999 })]);
    setRoutineClient(stub.client as never);

    const res = await request(app).post(`/api/routines/${routine.id}/run`).set(auth(user.token));
    expect(res.body.run.status).toBe('failed');
    expect(res.body.run.error).toMatch(/Stopped after \d+ steps/);
    expect(res.body.run.iterations).toBe(8);
  });

  it('reports plainly when no AI provider is configured', async () => {
    const user = await makeUser(app, { email: 'rt-noai@flowerstore.ph' });
    const routine = await makeRoutine(user.token);
    setRoutineClient(null);

    const res = await request(app).post(`/api/routines/${routine.id}/run`).set(auth(user.token));
    expect(res.body.run.status).toBe('failed');
    expect(res.body.run.error).toMatch(/No AI provider/);
  });
});
