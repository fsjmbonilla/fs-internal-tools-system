import { describe, expect, it, vi } from 'vitest';
import { events } from './events.js';

describe('events bus', () => {
  it('delivers message.created to subscribers and isolates handler errors', () => {
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    events.on('message.created', bad);
    events.on('message.created', good);
    const payload = {
      message: { id: 1, channelId: 1, userId: 1, body: 'hi' },
      channel: { id: 1, isPrivate: false },
    };
    expect(() => events.emit('message.created', payload)).not.toThrow();
    expect(good).toHaveBeenCalledWith(payload);
    events.off('message.created', bad);
    events.off('message.created', good);
  });
});
