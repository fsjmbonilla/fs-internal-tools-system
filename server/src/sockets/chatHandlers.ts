import type { Server, Socket } from 'socket.io';
import { getVisibleChannel, isChannelMember } from '../services/channelService.js';
import { logger } from '../logger.js';
import { sendMessage, toggleReaction } from '../services/messageService.js';

interface SendPayload {
  channelId: number;
  body: string;
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
    try {
      const channel = await getVisibleChannel(payload.channelId, userId, isAdmin);
      if (!channel || (!isAdmin && !(await isChannelMember(payload.channelId, userId)))) {
        ack?.({ ok: false, error: 'not_found' });
        return;
      }
      const message = await sendMessage(payload.channelId, userId, payload.body);
      io.to(`channel:${payload.channelId}`).emit('message:new', message);
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
