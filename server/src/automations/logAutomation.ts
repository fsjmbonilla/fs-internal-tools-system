import { logger } from '../logger.js';
import { events, type MessageCreatedEvent } from '../services/events.js';

export function registerLogAutomation(): void {
  events.on('message.created', (payload: MessageCreatedEvent) => {
    logger.debug(
      { messageId: payload.message.id, channelId: payload.channel.id },
      'message.created',
    );
  });
}
