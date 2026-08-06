import { config } from '../config.js';
import { logger } from '../logger.js';
import { checkAiBudget, recordAiUsage } from '../services/aiBudgetService.js';
import { triageSupportConversation } from '../services/aiService.js';
import { MAX_CONTEXT_MESSAGES, type TriageUsage } from '../services/ai/triage.js';
import { getBotUserId } from '../services/botService.js';
import { events, type MessageCreatedEvent } from '../services/events.js';
import { getMessagesBefore, sendMessage } from '../services/messageService.js';
import { getSupportConfig } from '../services/supportConfigService.js';
import { createTask } from '../services/taskService.js';

// The window the model actually reads, so the fetch and the prompt cannot drift apart.
const CONTEXT_MESSAGES = MAX_CONTEXT_MESSAGES;

// One pending timer per channel: a burst of rapid messages collapses into a single AI turn.
const pending = new Map<number, NodeJS.Timeout>();
// A triage takes seconds. The debounce coalesces messages *before* a call starts,
// but a message arriving mid-call used to start a second overlapping triage on the
// same channel — two tickets for one problem, and double the spend.
const inFlight = new Set<number>();

export function registerSupportIntake(): void {
  events.on('message.created', (payload: MessageCreatedEvent) => {
    // Bot messages must never re-trigger the AI, or the bot talks to itself
    // forever — except the ones the mailbox poller ingested (origin 'email'):
    // those are bot-authored only as a byline, and an emailed problem still
    // deserves triage. No loop reopens here, because the bot's own replies are
    // never email-ingested and so never carry the origin.
    if (payload.message.isBot && payload.message.origin !== 'email') return;
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
  // Email-ingested messages get the same exemption here as at the event guard.
  if (
    botUserId !== null &&
    payload.message.userId === botUserId &&
    payload.message.origin !== 'email'
  ) {
    return;
  }
  if (botUserId === null) {
    logger.warn('supportIntake: no bot user seeded — run `npm run seed:bot`');
    return;
  }

  // The spend ceiling. Checked here rather than at the event, so a burst still
  // collapses through the debounce first and only a real dispatch is counted.
  const budget = await checkAiBudget(channelId);
  if (!budget.ok) {
    logger.warn({ channelId, reason: budget.reason }, 'supportIntake: AI budget reached, skipping triage');
    return;
  }

  const history = await getMessagesBefore(channelId, null, CONTEXT_MESSAGES);
  let usage: TriageUsage | undefined;
  const decision = await triageSupportConversation({
    // getMessagesBefore returns newest-first; the AI reads oldest-first.
    messages: [...history].reverse().map((m) => ({ displayName: m.displayName, body: m.body })),
    instructions: supportConfig.instructions,
    onUsage: (u) => {
      usage = u;
    },
  });
  // Record before acting on the decision: a call that was dispatched is billable
  // and must consume this channel's interval whatever it decided, or failed to.
  if (usage) await recordAiUsage(channelId, usage);
  if (!decision) return; // AI unavailable or unusable — chat is unaffected

  // Nothing to do: acknowledgements, small talk, or a ticket already filed.
  // Returning here is what stops the bot acting on every message forever.
  if (decision.action === 'none') {
    logger.debug({ channelId }, 'supportIntake: no action needed');
    return;
  }

  if (decision.action === 'ask_clarification') {
    // A decision that names an action but omits its payload is a model fault, not a
    // no-op. Returning silently made it indistinguishable from "nothing to do".
    if (!decision.question) {
      logger.warn({ channelId }, 'supportIntake: ask_clarification with no question — ignoring');
      return;
    }
    await sendMessage(channelId, botUserId, decision.question);
    return;
  }

  if (!decision.title) {
    logger.warn({ channelId }, 'supportIntake: create_ticket with no title — ignoring');
    return;
  }
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
