import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';

export interface MessageCreatedEvent {
  message: {
    id: number;
    channelId: number;
    userId: number;
    displayName: string;
    body: string;
    mentionedUserIds: number[];
    isBot: boolean;
    /**
     * 'email' marks a message the mailbox poller ingested. It matters because
     * such messages are authored by the bot, and the intake automation's
     * bot-guard must wave exactly these through: an emailed problem still
     * deserves a ticket, while the bot's own replies (no origin) never
     * re-trigger anything.
     */
    origin?: 'email';
  };
  channel: {
    id: number;
    type: 'public' | 'private' | 'dm';
    kind: 'standard' | 'support';
    isPrivate: boolean;
  };
}

/**
 * Access was taken away and any live connection has to be told.
 *
 * A socket is authorized once at handshake and then joined to rooms, so
 * revocation has to be pushed — otherwise a removed member keeps receiving a
 * private channel's messages until they happen to reconnect, and a deactivated
 * user keeps their session until their token expires.
 */
export interface ChannelAccessRevokedEvent {
  userId: number;
  channelId: number;
}

/**
 * A task changed column.
 *
 * Emitted for support tickets so the conversation they came from hears about it:
 * someone who reported a problem in a support channel otherwise has to go and
 * look at a kanban board to find out whether anything happened.
 *
 * Only a real column change is emitted — moveTask also runs for reordering
 * within a column, and announcing that would be noise.
 */
export interface TaskMovedEvent {
  task: {
    id: number;
    title: string;
    source: 'manual' | 'support';
    originChannelId: number | null;
  };
  fromColumnName: string | null;
  toColumnName: string;
  movedByUserId: number | null;
}

export interface UserSessionsInvalidatedEvent {
  userId: number;
  reason: 'deactivated' | 'role_changed';
}

interface EventMap {
  'task.moved': TaskMovedEvent;
  'message.created': MessageCreatedEvent;
  'access.channelRevoked': ChannelAccessRevokedEvent;
  'access.userSessionsInvalidated': UserSessionsInvalidatedEvent;
}

class TypedBus extends EventEmitter {
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): boolean {
    // Isolate each listener: one automation's bug must never break message send.
    for (const listener of this.listeners(event)) {
      try {
        (listener as (p: EventMap[K]) => void)(payload);
      } catch (err) {
        logger.error({ err, event }, 'automation handler failed');
      }
    }
    return true;
  }

  on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): this {
    return super.on(event, handler);
  }

  off<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): this {
    return super.off(event, handler);
  }
}

export const events = new TypedBus();
