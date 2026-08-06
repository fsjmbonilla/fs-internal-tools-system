import type { Server, Socket } from 'socket.io';
import { getVisibleChannel } from '../services/channelService.js';
// The same visibility-then-membership rule the REST routes and agents use.
import { channelForWriting } from '../services/access.js';
import { logger } from '../logger.js';
import { sendMessage, toggleReaction } from '../services/messageService.js';
import { takeSendToken } from './sendRateLimit.js';

interface SendPayload {
  channelId: number;
  body: string;
  attachmentIds?: number[];
}

interface ReactionPayload {
  messageId: number;
  channelId: number;
  emoji: string;
}

type Ack = (result: { ok: boolean; error?: string; [key: string]: unknown }) => void;

export function registerChatHandlers(io: Server, socket: Socket): void {
  socket.on('channel:join', async (channelId: number) => {
    const isAdmin = socket.data.role === 'admin';
    const channel = await getVisibleChannel(channelId, socket.data.userId, isAdmin);
    if (!channel) return; // silently refuse — no existence leak
    socket.join(`channel:${channelId}`);
  });

  socket.on('channel:leave', (channelId: number) => {
    socket.leave(`channel:${channelId}`);
  });

  socket.on('message:send', async (payload: SendPayload, ack?: Ack) => {
    const userId = socket.data.userId as number;
    const isAdmin = socket.data.role === 'admin';
    // Over-limit is acked, never disconnected: a client hitting the ceiling is
    // usually pasting, not attacking, and dropping its connection would lose
    // messages it already considers sent.
    if (!takeSendToken(socket)) {
      ack?.({ ok: false, error: 'rate_limited' });
      return;
    }
    try {
      // Membership, not just visibility: a public channel is readable by
      // everyone and writable by the people in it.
      if (!(await channelForWriting(payload.channelId, { userId, isAdmin }))) {
        ack?.({ ok: false, error: 'not_found' });
        return;
      }
      // sendMessage broadcasts to the channel itself, so every producer (this
      // handler, the REST route, the support automation) delivers identically.
      const message = await sendMessage(payload.channelId, userId, payload.body, payload.attachmentIds);
      ack?.({ ok: true, message });
    } catch (err) {
      logger.error({ err }, 'message:send failed');
      ack?.({ ok: false, error: err instanceof Error ? err.message : 'send failed' });
    }
  });

  socket.on('message:reaction', async (payload: ReactionPayload, ack?: Ack) => {
    const userId = socket.data.userId as number;
    try {
      const result = await toggleReaction(payload.messageId, userId, payload.emoji);
      io.to(`channel:${payload.channelId}`).emit('message:reaction', {
        messageId: payload.messageId,
        userId,
        emoji: payload.emoji,
        added: result.added,
      });
      ack?.({ ok: true, ...result });
    } catch (err) {
      ack?.({ ok: false, error: err instanceof Error ? err.message : 'reaction failed' });
    }
  });

  socket.on('typing:start', (channelId: number) => {
    socket.to(`channel:${channelId}`).emit('typing', {
      channelId,
      userId: socket.data.userId,
      isTyping: true,
    });
  });

  socket.on('typing:stop', (channelId: number) => {
    socket.to(`channel:${channelId}`).emit('typing', {
      channelId,
      userId: socket.data.userId,
      isTyping: false,
    });
  });
}
