import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channels, users } from '../db/schema/index.js';
import { logger } from '../logger.js';
import { getBotUserId } from '../services/botService.js';
import { events, type TaskMovedEvent } from '../services/events.js';
import { sendMessage } from '../services/messageService.js';

/**
 * Report a ticket's status back to the conversation it came from.
 *
 * Someone reports a problem in a support channel, the AI files a ticket, and
 * then — until now — nothing. They had to go and read a kanban board to learn
 * whether anyone had picked it up. This closes the loop: moving the ticket
 * between columns posts the new status where the request was made.
 *
 * An automation rather than a call inside taskService, which is the whole point
 * of the event bus: moving a task should not have to know that chat exists.
 */
export function registerTicketStatus(): void {
  events.on('task.moved', (payload: TaskMovedEvent) => {
    announce(payload).catch((err) => {
      // A failed announcement must never fail the move that triggered it.
      logger.error({ err, taskId: payload.task.id }, 'ticketStatus announcement failed');
    });
  });
}

async function announce(payload: TaskMovedEvent): Promise<void> {
  const { task, fromColumnName, toColumnName, movedByUserId } = payload;

  // Only tickets have somewhere to report to; a manually created task has no
  // originating conversation.
  if (task.source !== 'support' || task.originChannelId === null) return;

  const botUserId = await getBotUserId();
  if (botUserId === null) {
    logger.warn('ticketStatus: no bot user seeded — run `npm run seed:bot`');
    return;
  }

  // The channel may have been deleted since the ticket was filed; posting into it
  // would fail on the foreign key.
  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.id, task.originChannelId));
  if (!channel) {
    logger.debug({ taskId: task.id }, 'ticketStatus: origin channel is gone');
    return;
  }

  const actor = movedByUserId === null ? null : await displayName(movedByUserId);
  const who = actor ? `${actor} moved` : 'Moved';
  const journey = fromColumnName ? `${fromColumnName} → ${toColumnName}` : toColumnName;

  await sendMessage(
    task.originChannelId,
    botUserId,
    `${who} ticket #${task.id} “${task.title}” to ${journey}`,
  );
}

async function displayName(userId: number): Promise<string | null> {
  const [row] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId));
  return row?.displayName ?? null;
}
