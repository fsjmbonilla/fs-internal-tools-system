import { logger } from '../logger.js';
import { getOtherDmMember } from '../services/channelService.js';
import { events, type MessageCreatedEvent } from '../services/events.js';
import { sendPushToUsers } from '../services/pushService.js';

const MAX_BODY_PREVIEW = 120;

function preview(body: string): string {
  return body.length > MAX_BODY_PREVIEW ? `${body.slice(0, MAX_BODY_PREVIEW)}…` : body;
}

export function registerPushAutomation(): void {
  events.on('message.created', (payload: MessageCreatedEvent) => {
    handleMessageCreated(payload).catch((err) => {
      logger.error({ err }, 'pushAutomation failed');
    });
  });
}

async function handleMessageCreated(payload: MessageCreatedEvent): Promise<void> {
  const { message, channel } = payload;
  let recipientUserIds: number[];
  if (channel.type === 'dm') {
    const otherUserId = await getOtherDmMember(channel.id, message.userId);
    recipientUserIds = otherUserId === null ? [] : [otherUserId];
  } else {
    recipientUserIds = message.mentionedUserIds;
  }
  if (recipientUserIds.length === 0) return;

  await sendPushToUsers(recipientUserIds, {
    title: channel.type === 'dm' ? message.displayName : `${message.displayName} mentioned you`,
    body: preview(message.body),
    channelId: channel.id,
  });
}
