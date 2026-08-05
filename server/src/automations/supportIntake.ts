import { config } from '../config.js';
import { logger } from '../logger.js';
import { triageSupportConversation } from '../services/aiService.js';
import { getBotUserId } from '../services/botService.js';
import { events, type MessageCreatedEvent } from '../services/events.js';
import { getMessagesBefore, sendMessage } from '../services/messageService.js';
import { getSupportConfig } from '../services/supportConfigService.js';
import { createTask } from '../services/taskService.js';

const CONTEXT_MESSAGES = 20;

// One pending timer per channel: a burst of rapid messages collapses into a single AI turn.
const pending = new Map<number, NodeJS.Timeout>();
// A triage takes seconds. The debounce coalesces messages *before* a call starts,
// but a message arriving mid-call used to start a second overlapping triage on the
// same channel — two tickets for one problem, and double the spend.
const inFlight = new Set<number>();

export function registerSupportIntake(): void {
  events.on('message.created', (payload: MessageCreatedEvent) => {
    // Bot messages must never re-trigger the AI, or the bot talks to itself forever.
    if (payload.message.isBot) return;
    if (payload.channel.kind !== 'support') return;

    const channelId = payload.channel.id;
    const existing = pending.get(channelId);
    if (existing) clearTimeout(existing);
    pending.set(
      channelId,
      setTimeout(() => {
        pending.delete(channelId);
        if (inFlight.has(channelId)) {
          logger.debug({ channelId }, 'supportIntake: triage already running, skipping');
          return;
        }
        inFlight.add(channelId);
        handleSupportMessage(payload)
          .catch((err) => {
            logger.error({ err }, 'supportIntake failed');
          })
          .finally(() => inFlight.delete(channelId));
      }, config.SUPPORT_DEBOUNCE_MS),
    );
  });
}

async function handleSupportMessage(payload: MessageCreatedEvent): Promise<void> {
  const channelId = payload.channel.id;
  const supportConfig = await getSupportConfig(channelId);
  if (!supportConfig || !supportConfig.aiEnabled) return;

  const botUserId = await getBotUserId();
  // Belt-and-braces against the bot answering itself: payload.message.isBot is the
  // primary guard, but it depends on users.is_bot being true, which a manual
  // UPDATE or a pre-existing account at that address could silently undo.
  if (botUserId !== null && payload.message.userId === botUserId) return;
  if (botUserId === null) {
    logger.warn('supportIntake: no bot user seeded — run `npm run seed:bot`');
    return;
  }

  const history = await getMessagesBefore(channelId, null, CONTEXT_MESSAGES);
  const decision = await triageSupportConversation({
    // getMessagesBefore returns newest-first; the AI reads oldest-first.
    messages: [...history].reverse().map((m) => ({ displayName: m.displayName, body: m.body })),
    instructions: supportConfig.instructions,
  });
  if (!decision) return; // AI unavailable or unusable — chat is unaffected

  // Nothing to do: acknowledgements, small talk, or a ticket already filed.
  // Returning here is what stops the bot acting on every message forever.
  if (decision.action === 'none') {
    logger.debug({ channelId }, 'supportIntake: no action needed');
    return;
  }

  if (decision.action === 'ask_clarification') {
    if (!decision.question) return;
    await sendMessage(channelId, botUserId, decision.question);
    return;
  }

  if (!decision.title) return;
  const ticket = await createTask({
    projectId: supportConfig.projectId,
    columnId: supportConfig.intakeColumnId,
    title: decision.title,
    description: decision.description ?? undefined,
    createdBy: botUserId,
    originChannelId: channelId,
    originMessageId: payload.message.id,
    source: 'support',
    priority: decision.priority ?? undefined,
  });
  await sendMessage(channelId, botUserId, `Filed ticket #${ticket.id}: ${ticket.title}`);
}
