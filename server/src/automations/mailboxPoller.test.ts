/**
 * Support-mailbox poller — Phase 12.
 *
 * The properties that matter: ingest is idempotent (a replayed tick, or a
 * restart between ingest and watermark write, must not duplicate a message),
 * an ingested email *does* trigger the intake AI even though the bot authors
 * it (that is the whole email-to-ticket path), the bot's own replies still do
 * not, and a dead mailbox grant degrades to a skipped tick — never a crash
 * loop.
 */

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db/index.js';
import {
  gmailIngestState,
  googleAccounts,
  messageEmailOrigins,
  messages,
  tasks,
} from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { ensureBotUser, getBotUserId } from '../services/botService.js';
import { createChannel } from '../services/channelService.js';
import { makeFakeGoogle, type FakeGoogle } from '../services/google/fake.js';
import { setGooglePortForTesting } from '../services/google/port.js';
import { encryptToken } from '../services/googleCrypto.js';
import { sendMessage } from '../services/messageService.js';
import { createProject } from '../services/projectService.js';
import { resolveIntakeColumnId, upsertSupportConfig } from '../services/supportConfigService.js';
import { createDefaultColumns } from '../services/taskService.js';
import { makeUser } from '../testHelpers.js';
import { isMailboxPollerArmed, pollMailboxOnce } from './mailboxPoller.js';
import { registerSupportIntake } from './supportIntake.js';

const triageSupportConversation = vi.hoisted(() => vi.fn());
vi.mock('../services/aiService.js', () => ({
  triageSupportConversation,
  isAiConfigured: () => true,
}));

// Same 50ms rationale as the supportIntake suite: longer than a MySQL round
// trip, short enough to wait for.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { config: { ...actual.config, SUPPORT_DEBOUNCE_MS: 50 } };
});

registerSupportIntake(); // once at module load, like real boot

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` }) as Record<string, string>;

let fake: FakeGoogle;

async function seedMailboxAccount(adminId: number, status: 'active' | 'broken' = 'active') {
  const [{ id }] = await db
    .insert(googleAccounts)
    .values({
      userId: null,
      kind: 'support_mailbox',
      googleEmail: 'support@flowerstore.ph',
      refreshTokenEnc: encryptToken('fake-refresh-token'),
      scopes: [],
      status,
      connectedBy: adminId,
    })
    .$returningId();
  return id;
}

async function seedSupportChannel(ownerId: number) {
  const project = await createProject({ name: 'helpdesk', isPrivate: false, createdBy: ownerId });
  await createDefaultColumns(project.id);
  const intakeColumnId = (await resolveIntakeColumnId(project.id))!;
  const channel = await createChannel({
    name: 'support-mail',
    isPrivate: false,
    createdBy: ownerId,
    kind: 'support',
  });
  await upsertSupportConfig({ channelId: channel.id, projectId: project.id, intakeColumnId });
  return { project, channel };
}

function anEmail(id: string, internalDate: number, subject = 'Order missing') {
  return {
    id,
    internalDate,
    from: 'Customer <customer@example.com>',
    subject,
    snippet: 'My order never arrived.',
  };
}

beforeEach(async () => {
  await resetDb();
  triageSupportConversation.mockReset();
  // Default: the AI decides these do not need a ticket, so intake-agnostic
  // tests are not haunted by pending triage work.
  triageSupportConversation.mockResolvedValue({ action: 'none' });
  await ensureBotUser();
  fake = makeFakeGoogle();
  setGooglePortForTesting(fake);
});

afterEach(() => {
  setGooglePortForTesting(null);
});

describe('pollMailboxOnce', () => {
  it('ingests new mail as bot messages with origin rows and advances the watermark', async () => {
    const { userId, token } = await makeUser(app, { admin: true });
    const accountId = await seedMailboxAccount(userId);
    const { channel } = await seedSupportChannel(userId);
    await db
      .insert(gmailIngestState)
      .values({ googleAccountId: accountId, targetChannelId: channel.id, lastInternalDate: 1000 });

    fake.ingest.push(anEmail('g1', 2000), anEmail('g2', 3000, 'Refund please'));

    const { ingested } = await pollMailboxOnce();
    expect(ingested).toBe(2);

    const posted = await db.select().from(messages).where(eq(messages.channelId, channel.id));
    expect(posted).toHaveLength(2);
    expect(posted[0].body).toContain('Order missing');
    expect(posted[0].body).toContain('customer@example.com');
    expect(posted[0].userId).toBe(await getBotUserId());

    const origins = await db.select().from(messageEmailOrigins);
    expect(origins.map((o) => o.gmailMessageId).sort()).toEqual(['g1', 'g2']);

    const [state] = await db.select().from(gmailIngestState);
    expect(state.lastInternalDate).toBe(3000);

    // Admin status reflects the binding.
    const status = await request(app).get('/api/admin/google/support-mailbox').set(auth(token));
    expect(status.body.targetChannelId).toBe(channel.id);
  });

  it('a replayed tick ingests nothing twice (restart between ingest and watermark)', async () => {
    const { userId } = await makeUser(app, { admin: true });
    const accountId = await seedMailboxAccount(userId);
    const { channel } = await seedSupportChannel(userId);
    await db
      .insert(gmailIngestState)
      .values({ googleAccountId: accountId, targetChannelId: channel.id, lastInternalDate: 1000 });
    fake.ingest.push(anEmail('g1', 2000));

    await pollMailboxOnce();
    // Simulate the crash: the watermark write never landed.
    await db.update(gmailIngestState).set({ lastInternalDate: 1000 });
    const { ingested } = await pollMailboxOnce();

    expect(ingested).toBe(0);
    expect(await db.$count(messages, eq(messages.channelId, channel.id))).toBe(1);
    // And the replay still repaired the watermark.
    const [state] = await db.select().from(gmailIngestState);
    expect(state.lastInternalDate).toBe(2000);
  });

  it('ignores mail at or before the watermark', async () => {
    const { userId } = await makeUser(app, { admin: true });
    const accountId = await seedMailboxAccount(userId);
    const { channel } = await seedSupportChannel(userId);
    await db
      .insert(gmailIngestState)
      .values({ googleAccountId: accountId, targetChannelId: channel.id, lastInternalDate: 5000 });
    fake.ingest.push(anEmail('old', 4000), anEmail('exact', 5000));

    const { ingested } = await pollMailboxOnce();
    expect(ingested).toBe(0);
  });

  it('a broken connection means a quiet skip, not a throw', async () => {
    const { userId } = await makeUser(app, { admin: true });
    const accountId = await seedMailboxAccount(userId, 'broken');
    const { channel } = await seedSupportChannel(userId);
    await db
      .insert(gmailIngestState)
      .values({ googleAccountId: accountId, targetChannelId: channel.id, lastInternalDate: 0 });
    fake.ingest.push(anEmail('g1', 2000));

    await expect(pollMailboxOnce()).resolves.toEqual({ ingested: 0 });
  });

  it('a grant dying mid-poll marks the row broken; the next tick skips', async () => {
    const { userId } = await makeUser(app, { admin: true });
    const accountId = await seedMailboxAccount(userId);
    const { channel } = await seedSupportChannel(userId);
    await db
      .insert(gmailIngestState)
      .values({ googleAccountId: accountId, targetChannelId: channel.id, lastInternalDate: 0 });
    fake.breakGrant();

    await expect(pollMailboxOnce()).resolves.toEqual({ ingested: 0 });
    const [row] = await db.select().from(googleAccounts);
    expect(row.status).toBe('broken');
    await expect(pollMailboxOnce()).resolves.toEqual({ ingested: 0 });
  });
});

describe('email-to-ticket (the intake exemption)', () => {
  it('an ingested email triggers triage and files a ticket', async () => {
    const { userId } = await makeUser(app, { admin: true });
    const accountId = await seedMailboxAccount(userId);
    const { project, channel } = await seedSupportChannel(userId);
    await db
      .insert(gmailIngestState)
      .values({ googleAccountId: accountId, targetChannelId: channel.id, lastInternalDate: 0 });
    triageSupportConversation.mockResolvedValue({
      action: 'create_ticket',
      question: null,
      title: 'Order never arrived',
      description: 'Customer reports a missing order.',
      priority: 'high',
    });

    fake.ingest.push(anEmail('g1', 2000));
    await pollMailboxOnce();

    await vi.waitFor(async () => {
      expect(await db.$count(tasks)).toBe(1);
    });
    const [ticket] = await db.select().from(tasks);
    expect(ticket.projectId).toBe(project.id);
    expect(ticket.source).toBe('support');
    expect(ticket.originChannelId).toBe(channel.id);
  });

  it("the bot's own replies still never trigger triage", async () => {
    const { userId } = await makeUser(app, { admin: true });
    const { channel } = await seedSupportChannel(userId);
    const botUserId = (await getBotUserId())!;

    await sendMessage(channel.id, botUserId, 'Filed ticket #1: something');
    await new Promise((r) => setTimeout(r, 150)); // outlast the 50ms debounce
    expect(triageSupportConversation).not.toHaveBeenCalled();
  });
});

describe('admin binding routes', () => {
  it('binds only support channels, and only with a connected mailbox', async () => {
    const { userId, token } = await makeUser(app, { admin: true });
    const standard = await createChannel({
      name: 'general',
      isPrivate: false,
      createdBy: userId,
    });

    // No mailbox connected yet.
    const early = await request(app)
      .put('/api/admin/google/support-mailbox')
      .set(auth(token))
      .send({ targetChannelId: standard.id });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('google_not_connected');

    await seedMailboxAccount(userId);
    const wrongKind = await request(app)
      .put('/api/admin/google/support-mailbox')
      .set(auth(token))
      .send({ targetChannelId: standard.id });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.error.code).toBe('not_a_support_channel');

    const { channel } = await seedSupportChannel(userId);
    const ok = await request(app)
      .put('/api/admin/google/support-mailbox')
      .set(auth(token))
      .send({ targetChannelId: channel.id });
    expect(ok.status).toBe(200);
    expect(isMailboxPollerArmed()).toBe(true);

    // The watermark was seeded at bind time — pre-existing mail is history.
    const [state] = await db.select().from(gmailIngestState);
    expect(state.lastInternalDate).toBeGreaterThan(0);

    const unbind = await request(app)
      .delete('/api/admin/google/support-mailbox')
      .set(auth(token));
    expect(unbind.status).toBe(200);
    expect(isMailboxPollerArmed()).toBe(false);
    expect(await db.$count(gmailIngestState)).toBe(0);
  });

  it('is invisible to non-admins (404, the admin-surface privacy rule)', async () => {
    const { token } = await makeUser(app);
    const res = await request(app)
      .put('/api/admin/google/support-mailbox')
      .set(auth(token))
      .send({ targetChannelId: 1 });
    expect(res.status).toBe(404);
  });
});
