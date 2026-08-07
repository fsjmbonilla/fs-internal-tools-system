/**
 * The "Today" dashboard.
 *
 * The properties under test: every section reuses the visibility the rest of
 * the platform enforces (a ticket in a project you cannot see does not exist),
 * unread mirrors what the sidebar shows, the Google sections degrade to null
 * for the unconnected rather than failing the whole dashboard, and the AI
 * summary is a budgeted paid call on the provider-switchable setup triage
 * uses, built from titles only. Notes are absent by construction —
 * dashboardService imports nothing note-shaped.
 *
 * The unconfigured-AI 503 lives in dashboard.summaryUnconfigured.test.ts,
 * because this file pins a configured provider into the config mock.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openaiCreate = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));
// The summary must run on whatever AI_PROVIDER selects — pin it so the suite
// does not depend on a developer's .env. Everything else stays real.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    config: { ...actual.config, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', AI_MODEL: '' },
  };
});

import { createApp } from '../app.js';
import { db } from '../db/index.js';
import { taskColumns } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { todaysAiCallCount } from '../services/aiBudgetService.js';
import { addChannelMember, createChannel, findOrCreateDm } from '../services/channelService.js';
import { makeFakeGoogle, type FakeGoogle } from '../services/google/fake.js';
import { setGooglePortForTesting } from '../services/google/port.js';
import { sendMessage } from '../services/messageService.js';
import { createProject } from '../services/projectService.js';
import { createDefaultColumns, createTask } from '../services/taskService.js';
import { makeUser } from '../testHelpers.js';
import { eq } from 'drizzle-orm';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` }) as Record<string, string>;

let fake: FakeGoogle;

beforeEach(async () => {
  await resetDb();
  openaiCreate.mockReset();
  fake = makeFakeGoogle();
  setGooglePortForTesting(fake);
});

afterEach(() => {
  setGooglePortForTesting(null);
});

async function connectedUser(opts: { admin?: boolean } = {}) {
  const user = await makeUser(app, opts);
  const urlRes = await request(app).get('/api/google/auth-url').set(auth(user.token));
  const state = new URL(urlRes.body.url).searchParams.get('state')!;
  await request(app).get(`/api/google/callback?code=good-code&state=${state}`);
  return user;
}

/** A project with default columns; returns the project and its first column id. */
async function makeProject(createdBy: number, opts: { isPrivate?: boolean; name?: string } = {}) {
  const project = await createProject({
    name: opts.name ?? `proj-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    isPrivate: opts.isPrivate ?? false,
    createdBy,
  });
  await createDefaultColumns(project.id);
  const [column] = await db
    .select()
    .from(taskColumns)
    .where(eq(taskColumns.projectId, project.id));
  return { project, columnId: column.id };
}

describe('GET /api/dashboard/today', () => {
  it('returns every section for a connected user', async () => {
    const me = await connectedUser();
    const other = await makeUser(app);

    // An event today and one shared file (plus one of my own that must not appear).
    fake.events.push({
      id: 'evt_today',
      title: 'Standup',
      start: new Date().toISOString(),
      end: new Date(Date.now() + 3600_000).toISOString(),
      allDay: false,
      attendees: [],
      location: null,
      description: null,
      htmlLink: null,
    });
    fake.addDriveFile({ name: 'Q3 targets.xlsx', sharedWithMe: true, owner: 'boss@flowerstore.ph' });
    fake.addDriveFile({ name: 'my-own-notes.pdf' });

    // Something unread: the other user posts where I am a member.
    const channel = await createChannel({ name: 'ops', isPrivate: false, createdBy: other.userId });
    await addChannelMember(channel.id, me.userId);
    await sendMessage(channel.id, other.userId, 'morning!');

    // A support ticket filed today in a project I can see, and the new project itself.
    const { project, columnId } = await makeProject(other.userId, { name: 'helpdesk' });
    await createTask({
      projectId: project.id,
      columnId,
      title: 'Printer down',
      createdBy: other.userId,
      source: 'support',
    });

    const res = await request(app).get('/api/dashboard/today').set(auth(me.token));
    expect(res.status).toBe(200);

    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].title).toBe('Standup');

    expect(res.body.sharedFiles.map((f: { name: string }) => f.name)).toEqual(['Q3 targets.xlsx']);
    expect(res.body.sharedFiles[0].owner).toBe('boss@flowerstore.ph');

    const unreadChannel = res.body.unread.channels.find(
      (c: { id: number }) => c.id === channel.id,
    );
    expect(unreadChannel).toMatchObject({ name: 'ops', unreadCount: 1 });

    expect(res.body.newTickets).toHaveLength(1);
    expect(res.body.newTickets[0]).toMatchObject({
      title: 'Printer down',
      projectId: project.id,
      projectName: 'helpdesk',
      columnName: 'Todo',
    });

    expect(res.body.newProjects.map((p: { name: string }) => p.name)).toContain('helpdesk');
  });

  it('returns null events and sharedFiles when Google is not connected — never a 409', async () => {
    const me = await makeUser(app);
    const res = await request(app).get('/api/dashboard/today').set(auth(me.token));
    expect(res.status).toBe(200);
    expect(res.body.events).toBeNull();
    expect(res.body.sharedFiles).toBeNull();
    // The rest of the dashboard still answers.
    expect(res.body.unread).toEqual({ channels: [], dms: [] });
    expect(res.body.newTickets).toEqual([]);
    expect(res.body.newProjects).toEqual([]);
  });

  it('unread reflects a message sent to a channel and a DM, and clears nothing it should not', async () => {
    const me = await makeUser(app);
    const other = await makeUser(app);

    const channel = await createChannel({ name: 'general', isPrivate: false, createdBy: me.userId });
    await addChannelMember(channel.id, other.userId);
    await sendMessage(channel.id, other.userId, 'one');
    await sendMessage(channel.id, other.userId, 'two');

    const dm = await findOrCreateDm(other.userId, me.userId);
    await sendMessage(dm.id, other.userId, 'psst');

    const res = await request(app).get('/api/dashboard/today').set(auth(me.token));
    expect(res.status).toBe(200);
    expect(res.body.unread.channels).toEqual([
      expect.objectContaining({ id: channel.id, name: 'general', unreadCount: 2 }),
    ]);
    expect(res.body.unread.dms).toEqual([
      expect.objectContaining({ id: dm.id, unreadCount: 1 }),
    ]);
  });

  it('a support ticket in an invisible project does not appear, and neither does the project', async () => {
    const me = await makeUser(app);
    const other = await makeUser(app);

    const hidden = await makeProject(other.userId, { isPrivate: true, name: 'secret-ops' });
    await createTask({
      projectId: hidden.project.id,
      columnId: hidden.columnId,
      title: 'Hidden ticket',
      createdBy: other.userId,
      source: 'support',
    });
    const visible = await makeProject(other.userId, { name: 'public-ops' });
    await createTask({
      projectId: visible.project.id,
      columnId: visible.columnId,
      title: 'Visible ticket',
      createdBy: other.userId,
      source: 'support',
    });
    // A manual task today must not show up either — this is a support-intake feed.
    await createTask({
      projectId: visible.project.id,
      columnId: visible.columnId,
      title: 'Manual task',
      createdBy: other.userId,
    });

    const res = await request(app).get('/api/dashboard/today').set(auth(me.token));
    expect(res.body.newTickets.map((t: { title: string }) => t.title)).toEqual(['Visible ticket']);
    expect(res.body.newProjects.map((p: { name: string }) => p.name)).toEqual(['public-ops']);

    // The member of the private project sees its ticket.
    const asOwner = await request(app).get('/api/dashboard/today').set(auth(other.token));
    expect(asOwner.body.newTickets.map((t: { title: string }) => t.title).sort()).toEqual([
      'Hidden ticket',
      'Visible ticket',
    ]);
  });

  it('requires a user token', async () => {
    const res = await request(app).get('/api/dashboard/today');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/dashboard/summary', () => {
  it('summarizes from titles only on the configured provider, and books the call in the ai_usage ledger', async () => {
    const me = await makeUser(app);
    const other = await makeUser(app);
    const { project, columnId } = await makeProject(other.userId, { name: 'helpdesk' });
    await createTask({
      projectId: project.id,
      columnId,
      title: 'Printer down',
      createdBy: other.userId,
      source: 'support',
    });

    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: 'One new ticket in helpdesk; otherwise quiet.' } }],
      usage: { prompt_tokens: 42, completion_tokens: 12 },
    });

    const res = await request(app).post('/api/dashboard/summary').set(auth(me.token)).send({});
    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('One new ticket in helpdesk; otherwise quiet.');

    // The provider AI_PROVIDER selects answered, from a prompt of titles only.
    const params = openaiCreate.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const prompt = params.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('Printer down');

    // The paid call landed in the ledger with its token counts (invariant 7).
    expect(await todaysAiCallCount()).toBe(1);
  });

  it('records the attempt even when the provider fails', async () => {
    const me = await makeUser(app);
    openaiCreate.mockRejectedValue(new Error('overloaded'));

    const res = await request(app).post('/api/dashboard/summary').set(auth(me.token)).send({});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('ai_error');
    expect(await todaysAiCallCount()).toBe(1);
  });
});
