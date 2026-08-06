/**
 * The MCP endpoint, exercised over real HTTP with real JSON-RPC envelopes.
 *
 * Driven with supertest rather than an in-memory client transport on purpose: the
 * things worth proving are at the HTTP seam — that an unauthenticated POST is
 * refused, that a user's browser session cannot reach the endpoint, and that the
 * tool manifest a client receives is bounded by the token's scopes.
 */

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db/index.js';
import { resetDb } from '../db/testUtils.js';
import { channels, tasks } from '../db/schema/index.js';
import { addChannelMember, createChannel } from '../services/channelService.js';
import { ensureBotUser } from '../services/botService.js';
import { addProjectMember, createProject } from '../services/projectService.js';
import { createDefaultColumns, getBoard } from '../services/taskService.js';
import { registerTicketStatus } from '../automations/ticketStatus.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

// The move announcement is an automation listening on the shared event bus, and
// createApp() does not register it — index.ts does, at boot. Registering here is
// what makes this suite exercise the same wiring production runs.
registerTicketStatus();

/** The announcement is fire-and-forget, so the move returns before it lands. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const PROTOCOL_VERSION = '2025-06-18';

/** A JSON-RPC call against /mcp, with the headers a Streamable HTTP client sends. */
function rpc(token: string | null, method: string, params?: unknown) {
  const req = request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send({ jsonrpc: '2.0', id: 1, method, params: params ?? {} });
}

/**
 * Initialize, then call. The 2025 stateless leg answers each request from a fresh
 * instance, so an `initialize` is not carried over — but sending it first is what
 * a real client does, and it is also how the protocol version gets negotiated.
 */
async function initialize(token: string) {
  return rpc(token, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  });
}

/** Streamable HTTP may answer as JSON or as a single SSE event; accept both. */
function payload(res: { headers: Record<string, string>; text: string; body: unknown }) {
  if (res.headers['content-type']?.includes('text/event-stream')) {
    const line = res.text
      .split('\n')
      .find((l) => l.startsWith('data:'));
    if (!line) throw new Error(`no SSE data in: ${res.text}`);
    return JSON.parse(line.slice(5).trim());
  }
  return res.body;
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(token, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  const body = payload(res);
  if (body.error) throw new Error(`rpc error: ${JSON.stringify(body.error)}`);
  return body.result as { isError?: boolean; content: { text: string }[] };
}

/** Tool results carry JSON in a text block; parse it back for assertions. */
function parsed(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

const ALL_SCOPES = [
  'tickets:read',
  'tickets:write',
  'chat:read',
  'chat:write',
  'docs:read',
  'docs:write',
];

async function scenario(scopes: string[] = ALL_SCOPES) {
  const admin = await makeUser(app, { email: 'a@flowerstore.ph', admin: true });
  const botId = await ensureBotUser();
  const project = await createProject({
    name: 'Facilities',
    isPrivate: false,
    createdBy: admin.userId,
  });
  await createDefaultColumns(project.id);
  await addProjectMember(project.id, botId);
  const board = await getBoard(project.id);

  const minted = await request(app)
    .post('/api/admin/tokens')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'agent', scopes, actsAsUserId: botId })
    .expect(201);

  return {
    admin,
    botId,
    token: minted.body.token as string,
    projectId: project.id,
    columnId: board.columns[0].id,
    columns: board.columns,
  };
}

describe('the MCP endpoint is a service-token surface', () => {
  beforeEach(resetDb);

  it('refuses an unauthenticated call', async () => {
    await scenario();
    const res = await rpc(null, 'tools/list');
    expect(res.status).toBe(401);
  });

  it('refuses a forged token', async () => {
    await scenario();
    const res = await rpc(`fsk_${'b'.repeat(64)}`, 'tools/list');
    expect(res.status).toBe(401);
  });

  it("refuses a person's access token", async () => {
    const { admin } = await scenario();
    // A browser session already has the whole REST API. Letting a JWT in here
    // would give a stolen one a second, differently-shaped surface — and a user
    // has no scopes, so it would need a bypass to be useful at all.
    const res = await rpc(admin.token, 'tools/list');
    expect(res.status).toBe(401);
  });

  it('stops working when the token is revoked', async () => {
    const { admin, token } = await scenario();
    const listed = await request(app)
      .get('/api/admin/tokens')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await request(app)
      .delete(`/api/admin/tokens/${listed.body.tokens[0].id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect((await rpc(token, 'tools/list')).status).toBe(401);
  });

  it('initializes and reports its server info', async () => {
    const { token } = await scenario();
    const res = await initialize(token);
    expect(res.status).toBe(200);
    expect(payload(res).result.serverInfo).toMatchObject({ name: 'fs-internal-tools' });
  });
});

describe('the tool manifest is bounded by scopes', () => {
  beforeEach(resetDb);

  const names = async (token: string) => {
    const res = await rpc(token, 'tools/list');
    expect(res.status).toBe(200);
    return (payload(res).result.tools as { name: string }[]).map((t) => t.name).sort();
  };

  it('offers every tool to a token holding every scope — and no notes tool', async () => {
    const { token } = await scenario();
    const tools = await names(token);
    expect(tools).toEqual([
      'create_ticket',
      'get_ticket',
      'list_channels',
      'list_docs',
      'list_projects',
      'list_tickets',
      'move_ticket_status',
      'post_message',
      'read_doc',
      'search_messages',
      'update_ticket',
      'write_doc',
    ]);
    // The invariant this whole phase protects: there is no notes tool, and no
    // scope that could produce one.
    expect(tools.join(' ')).not.toContain('note');
  });

  it('offers a read-only ticket token exactly three tools', async () => {
    const { token } = await scenario(['tickets:read']);
    expect(await names(token)).toEqual(['get_ticket', 'list_projects', 'list_tickets']);
  });

  it('offers a chat-only token no ticket or doc tools', async () => {
    const { token } = await scenario(['chat:read', 'chat:write']);
    expect(await names(token)).toEqual(['list_channels', 'post_message', 'search_messages']);
  });
});

describe('the tools call the same services the REST routes call', () => {
  beforeEach(resetDb);

  it('creates a ticket attributed to the bot', async () => {
    const { token, botId, projectId, columnId } = await scenario();
    const result = await callTool(token, 'create_ticket', {
      projectId,
      columnId,
      title: 'AC leaking in Meeting Room B',
      priority: 'high',
    });
    expect(result.isError).toBeFalsy();
    const ticket = parsed(result);
    expect(ticket.title).toBe('AC leaking in Meeting Room B');

    const [row] = await db.select().from(tasks).where(eq(tasks.id, ticket.id));
    expect(row.createdBy).toBe(botId);
  });

  it('announces a status move in the channel the ticket came from', async () => {
    const { admin, token, botId, projectId, columnId, columns } = await scenario();
    const channel = await createChannel({
      name: 'facilities',
      isPrivate: false,
      createdBy: admin.userId,
    });
    await addChannelMember(channel.id, botId);

    // A ticket that remembers where it came from — the support-intake shape.
    const created = await callTool(token, 'create_ticket', {
      projectId,
      columnId,
      title: 'Door badge reader dead',
    });
    const ticketId = parsed(created).id;
    await db
      .update(tasks)
      .set({ originChannelId: channel.id, source: 'support' })
      .where(eq(tasks.id, ticketId));

    const before = await request(app)
      .get(`/api/channels/${channel.id}/messages`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const moved = await callTool(token, 'move_ticket_status', {
      ticketId,
      columnId: columns[1].id,
    });
    expect(moved.isError).toBeFalsy();
    await settle();

    const after = await request(app)
      .get(`/api/channels/${channel.id}/messages`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    // An agent moving a ticket looks like a person moving it to everyone watching.
    expect(after.body.messages.length).toBe(before.body.messages.length + 1);
    expect(after.body.messages.at(-1).body).toContain(columns[1].name);
  });

  it('posts a message only into a channel its bot joined', async () => {
    const { admin, token, botId } = await scenario();
    const joined = await createChannel({
      name: 'joined',
      isPrivate: false,
      createdBy: admin.userId,
    });
    await addChannelMember(joined.id, botId);
    const notJoined = await createChannel({
      name: 'not-joined',
      isPrivate: false,
      createdBy: admin.userId,
    });

    const good = await callTool(token, 'post_message', { channelId: joined.id, body: 'On it.' });
    expect(good.isError).toBeFalsy();

    // Visible but not a member: an agent that can see a channel must not be able
    // to talk in it.
    const bad = await callTool(token, 'post_message', {
      channelId: notJoined.id,
      body: 'should not appear',
    });
    expect(bad.isError).toBe(true);
    const [row] = await db.select().from(channels).where(eq(channels.id, notJoined.id));
    expect(row).toBeDefined();
  });

  it('refuses a project the bot cannot see, without saying it exists', async () => {
    const { admin, token } = await scenario();
    const secret = await createProject({
      name: 'Payroll',
      isPrivate: true,
      createdBy: admin.userId,
    });
    const result = await callTool(token, 'list_tickets', { projectId: secret.id });
    expect(result.isError).toBe(true);
    // "caller" rather than "token": the message is shared with AI Routines now,
    // which are not tokens. The refusal itself is unchanged — still no hint that
    // the project exists.
    expect(result.content[0].text).toBe('Not found, or not visible to this caller.');

    const projects = parsed(await callTool(token, 'list_projects'));
    expect(projects.projects.map((p: { name: string }) => p.name)).not.toContain('Payroll');
  });

  it('refuses a column that belongs to another project', async () => {
    const { admin, token, botId, projectId } = await scenario();
    const other = await createProject({
      name: 'Other',
      isPrivate: false,
      createdBy: admin.userId,
    });
    await createDefaultColumns(other.id);
    await addProjectMember(other.id, botId);
    const otherBoard = await getBoard(other.id);

    // Otherwise a column id becomes a way to write into a project the call never
    // named, past the check that authorized the named one.
    const result = await callTool(token, 'create_ticket', {
      projectId,
      columnId: otherBoard.columns[0].id,
      title: 'wrong board',
    });
    expect(result.isError).toBe(true);
  });

  it('writes and reads a doc', async () => {
    const { token, projectId } = await scenario();
    const created = parsed(
      await callTool(token, 'write_doc', {
        projectId,
        title: 'Runbook',
        content: 'Step one.',
      }),
    );
    const updated = parsed(
      await callTool(token, 'write_doc', { docId: created.id, content: 'Step one. Step two.' }),
    );
    expect(updated.content).toBe('Step one. Step two.');
    expect(parsed(await callTool(token, 'read_doc', { docId: created.id })).title).toBe('Runbook');
  });

  it('cannot call a tool outside its scopes even by name', async () => {
    const { token, projectId, columnId } = await scenario(['tickets:read']);
    // The manifest hid create_ticket; asking for it anyway must not work. A
    // filtered list is ergonomics — the boundary is the check on the call path.
    const res = await rpc(token, 'tools/call', {
      name: 'create_ticket',
      arguments: { projectId, columnId, title: 'unscoped' },
    });
    const body = payload(res);
    const refused = Boolean(body.error) || body.result?.isError === true;
    expect(refused).toBe(true);
    expect(await db.select().from(tasks)).toHaveLength(0);
  });
});
