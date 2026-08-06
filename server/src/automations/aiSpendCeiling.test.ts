/**
 * The spend ceiling where it actually matters: a steady stream of messages in a
 * support channel must stop reaching the paid provider.
 *
 * The debounce coalesces a *burst* before a call starts. It never throttled a
 * steady stream — a message every few seconds sustained hundreds of paid calls an
 * hour — which is the shape a spend runaway really takes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import { aiUsage, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { ensureBotUser } from '../services/botService.js';
import { createChannel } from '../services/channelService.js';
import { sendMessage } from '../services/messageService.js';
import { createProject } from '../services/projectService.js';
import { resolveIntakeColumnId, upsertSupportConfig } from '../services/supportConfigService.js';
import { createDefaultColumns } from '../services/taskService.js';

const triageSupportConversation = vi.hoisted(() => vi.fn());
vi.mock('../services/aiService.js', () => ({
  triageSupportConversation,
  isAiConfigured: () => true,
}));

// Debounce short enough to fire between messages (50ms outlasts the real MySQL
// round-trips inside sendMessage); interval long enough that the second message
// is inside it.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    config: { ...actual.config, SUPPORT_DEBOUNCE_MS: 50, AI_MIN_INTERVAL_MS: 60_000, AI_DAILY_CALL_CAP: 500 },
  };
});

const { registerSupportIntake } = await import('./supportIntake.js');

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

async function seedSupportChannel(ownerId: number, name: string) {
  const project = await createProject({ name: `${name}-proj`, isPrivate: false, createdBy: ownerId });
  await createDefaultColumns(project.id);
  const intakeColumnId = (await resolveIntakeColumnId(project.id))!;
  const channel = await createChannel({ name, isPrivate: false, createdBy: ownerId, kind: 'support' });
  await upsertSupportConfig({ channelId: channel.id, projectId: project.id, intakeColumnId });
  return { project, channel };
}

/** A provider that reports what it cost, the way the real ones do via onUsage. */
function mockTriageReportingUsage() {
  triageSupportConversation.mockImplementation(async (input: { onUsage?: (u: unknown) => void }) => {
    input.onUsage?.({ provider: 'openai', model: 'gpt-4.1-mini', promptTokens: 1200, completionTokens: 35 });
    return { action: 'none', question: null, title: null, description: null, priority: null };
  });
}

registerSupportIntake(); // once at module load, like real boot

describe('the AI spend ceiling, end to end', () => {
  beforeEach(async () => {
    await resetDb();
    triageSupportConversation.mockReset();
    await ensureBotUser();
  });

  it('stops a steady stream from reaching the provider a second time', async () => {
    mockTriageReportingUsage();
    const reporter = await seedUser('spend1@flowerstore.ph');
    const { channel } = await seedSupportChannel(reporter, 'spendhelp1');

    await sendMessage(channel.id, reporter, 'the lift is stuck again');
    await vi.waitFor(() => expect(triageSupportConversation).toHaveBeenCalledTimes(1));
    // The attempt is on the ledger, which is what the next check reads.
    await vi.waitFor(async () => expect(await db.select().from(aiUsage)).toHaveLength(1));

    // A second message, well after the debounce window — previously a second paid call.
    await sendMessage(channel.id, reporter, 'still stuck, any update?');
    await new Promise((r) => setTimeout(r, 200));

    expect(triageSupportConversation).toHaveBeenCalledTimes(1);
    expect(await db.select().from(aiUsage)).toHaveLength(1);
  });

  it('writes the token counts of the call it did make', async () => {
    mockTriageReportingUsage();
    const reporter = await seedUser('spend2@flowerstore.ph');
    const { channel } = await seedSupportChannel(reporter, 'spendhelp2');

    await sendMessage(channel.id, reporter, 'printer on fire');
    await vi.waitFor(async () => expect(await db.select().from(aiUsage)).toHaveLength(1));

    const [row] = await db.select().from(aiUsage);
    expect(row.channelId).toBe(channel.id);
    expect(row.promptTokens).toBe(1200);
    expect(row.completionTokens).toBe(35);
  });

  it('counts a dispatched call that failed, so a broken provider is not retried hot', async () => {
    // The provider reports usage then returns null (network error, refusal, bad
    // schema). It was still billed, and it must still consume the interval.
    triageSupportConversation.mockImplementation(async (input: { onUsage?: (u: unknown) => void }) => {
      input.onUsage?.({ provider: 'openai', model: 'gpt-4.1-mini', promptTokens: 800, completionTokens: 0 });
      return null;
    });
    const reporter = await seedUser('spend3@flowerstore.ph');
    const { channel } = await seedSupportChannel(reporter, 'spendhelp3');

    await sendMessage(channel.id, reporter, 'nothing works');
    await vi.waitFor(async () => expect(await db.select().from(aiUsage)).toHaveLength(1));

    await sendMessage(channel.id, reporter, 'hello?');
    await new Promise((r) => setTimeout(r, 200));

    expect(triageSupportConversation).toHaveBeenCalledTimes(1);
  });

  it('does not consume the interval when no call was dispatched', async () => {
    // An unconfigured provider returns null without calling onUsage — nothing was
    // billed, so nothing should be spent from the channel's budget either.
    triageSupportConversation.mockResolvedValue(null);
    const reporter = await seedUser('spend4@flowerstore.ph');
    const { channel } = await seedSupportChannel(reporter, 'spendhelp4');

    await sendMessage(channel.id, reporter, 'first');
    await vi.waitFor(() => expect(triageSupportConversation).toHaveBeenCalledTimes(1));

    await sendMessage(channel.id, reporter, 'second');
    await vi.waitFor(() => expect(triageSupportConversation).toHaveBeenCalledTimes(2));

    expect(await db.select().from(aiUsage)).toHaveLength(0);
  });
});
