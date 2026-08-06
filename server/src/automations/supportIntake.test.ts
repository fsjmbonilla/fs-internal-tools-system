import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import { tasks, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { ensureBotUser } from '../services/botService.js';
import { createChannel } from '../services/channelService.js';
import { getMessagesBefore, sendMessage } from '../services/messageService.js';
import { createProject } from '../services/projectService.js';
import {
  resolveIntakeColumnId,
  upsertSupportConfig,
} from '../services/supportConfigService.js';
import { createDefaultColumns } from '../services/taskService.js';
import { registerSupportIntake } from './supportIntake.js';

const triageSupportConversation = vi.hoisted(() => vi.fn());
vi.mock('../services/aiService.js', () => ({
  triageSupportConversation,
  isAiConfigured: () => true,
}));

// Debounce must be short in tests. 1ms (as originally drafted) is shorter than the real
// MySQL round-trips inside sendMessage, so each message's timer fired before the next
// message's event even landed — collapsing nothing. 50ms comfortably outlasts those
// round-trips while staying fast, so bursts sent back-to-back still land in one window.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { config: { ...actual.config, SUPPORT_DEBOUNCE_MS: 50 } };
});

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
  return { project, channel, intakeColumnId };
}

registerSupportIntake(); // once at module load, like real boot — not per-test

describe('supportIntake', () => {
  beforeEach(async () => {
    await resetDb();
    triageSupportConversation.mockReset();
    await ensureBotUser();
  });

  it('files a ticket in the bound intake column with origin links and priority', async () => {
    const reporter = await seedUser('reporter@flowerstore.ph');
    const { project, channel, intakeColumnId } = await seedSupportChannel(reporter, 'help1');
    triageSupportConversation.mockResolvedValue({
      action: 'create_ticket',
      question: null,
      title: 'Printer jammed on floor 2',
      description: 'Invoices cannot print.',
      priority: 'high',
    });

    const msg = await sendMessage(channel.id, reporter, 'the floor 2 printer is jammed');

    await vi.waitFor(async () => {
      const rows = await db.select().from(tasks);
      expect(rows).toHaveLength(1);
    });
    const [ticket] = await db.select().from(tasks);
    expect(ticket.projectId).toBe(project.id);
    expect(ticket.columnId).toBe(intakeColumnId);
    expect(ticket.title).toBe('Printer jammed on floor 2');
    expect(ticket.priority).toBe('high');
    expect(ticket.source).toBe('support');
    expect(ticket.originChannelId).toBe(channel.id);
    expect(ticket.originMessageId).toBe(msg.id);
  });

  it('posts the clarifying question as the bot, and the bot reply does not re-trigger the AI', async () => {
    const reporter = await seedUser('reporter2@flowerstore.ph');
    const { channel } = await seedSupportChannel(reporter, 'help2');
    triageSupportConversation.mockResolvedValue({
      action: 'ask_clarification',
      question: 'Which printer, and on which floor?',
      title: null,
      description: null,
      priority: null,
    });

    await sendMessage(channel.id, reporter, 'its broken');

    await vi.waitFor(async () => {
      const history = await getMessagesBefore(channel.id, null, 10);
      expect(history.some((m) => m.body === 'Which printer, and on which floor?')).toBe(true);
    });
    // The bot's own message must not cause a second AI turn.
    expect(triageSupportConversation).toHaveBeenCalledTimes(1);
    expect(await db.select().from(tasks)).toHaveLength(0);
  });

  it('ignores messages in a standard (non-support) channel', async () => {
    const u = await seedUser('u@flowerstore.ph');
    const channel = await createChannel({ name: 'general', isPrivate: false, createdBy: u });
    await sendMessage(channel.id, u, 'just chatting');
    await new Promise((r) => setTimeout(r, 30));
    expect(triageSupportConversation).not.toHaveBeenCalled();
  });

  it('does nothing when the support config has ai_enabled false', async () => {
    const reporter = await seedUser('reporter3@flowerstore.ph');
    const { project, channel, intakeColumnId } = await seedSupportChannel(reporter, 'help3');
    await upsertSupportConfig({
      channelId: channel.id,
      projectId: project.id,
      intakeColumnId,
      aiEnabled: false,
    });
    await sendMessage(channel.id, reporter, 'something is broken');
    await new Promise((r) => setTimeout(r, 30));
    expect(triageSupportConversation).not.toHaveBeenCalled();
  });

  it('leaves chat working when the AI returns null (outage/unconfigured)', async () => {
    const reporter = await seedUser('reporter4@flowerstore.ph');
    const { channel } = await seedSupportChannel(reporter, 'help4');
    triageSupportConversation.mockResolvedValue(null);

    const msg = await sendMessage(channel.id, reporter, 'printer broken');
    expect(msg.id).toBeGreaterThan(0); // send succeeded

    await new Promise((r) => setTimeout(r, 30));
    expect(await db.select().from(tasks)).toHaveLength(0);
  });

  it('debounces a burst of messages into a single AI turn', async () => {
    const reporter = await seedUser('reporter5@flowerstore.ph');
    const { channel } = await seedSupportChannel(reporter, 'help5');
    triageSupportConversation.mockResolvedValue({
      action: 'ask_clarification',
      question: 'Details?',
      title: null,
      description: null,
      priority: null,
    });

    await sendMessage(channel.id, reporter, 'hi');
    await sendMessage(channel.id, reporter, 'the printer');
    await sendMessage(channel.id, reporter, 'is broken');

    await vi.waitFor(() => expect(triageSupportConversation).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(triageSupportConversation).toHaveBeenCalledTimes(1);
  });

  it('hands the transcript to the AI oldest-first', async () => {
    // getMessagesBefore returns newest-first. Dropping the .reverse() would still
    // "work" — a ticket still gets filed — while quietly handing the model the
    // conversation backwards, which is a silent quality regression nothing else
    // in this suite would catch.
    const reporter = await seedUser('reporter6@flowerstore.ph');
    const { channel } = await seedSupportChannel(reporter, 'help6');
    triageSupportConversation.mockResolvedValue({
      action: 'none',
      question: null,
      title: null,
      description: null,
      priority: null,
    });

    await sendMessage(channel.id, reporter, 'first');
    await sendMessage(channel.id, reporter, 'second');
    await sendMessage(channel.id, reporter, 'third');

    await vi.waitFor(() => expect(triageSupportConversation).toHaveBeenCalled());
    const [{ messages }] = triageSupportConversation.mock.calls[0];
    expect(messages.map((m: { body: string }) => m.body)).toEqual(['first', 'second', 'third']);
  });
});
