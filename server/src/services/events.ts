import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';

export interface MessageCreatedEvent {
  message: { id: number; channelId: number; userId: number; body: string };
  channel: { id: number; isPrivate: boolean };
}

interface EventMap {
  'message.created': MessageCreatedEvent;
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
