import type { Server, Socket } from 'socket.io';
import { db } from '../db/index.js';
import { messages } from '../db/schema/index.js';
import { logger } from '../logger.js';

interface SendPayload {
  channelId: number;
  body: string;
}

type SendAck = (result: { ok: boolean; id?: number; error?: string }) => void;

export function registerChatHandlers(io: Server, socket: Socket): void {
  socket.on('channel:join', (channelId: string | number) => {
    socket.join(`channel:${channelId}`);
  });

  socket.on('channel:leave', (channelId: string | number) => {
    socket.leave(`channel:${channelId}`);
  });

  socket.on('message:send', async (payload: SendPayload, ack?: SendAck) => {
    const userId = socket.data.userId as number;
    try {
      const [{ id }] = await db
        .insert(messages)
        .values({ channelId: payload.channelId, userId, body: payload.body })
        .$returningId();
      io.to(`channel:${payload.channelId}`).emit('message:new', {
        id,
        channelId: payload.channelId,
        userId,
        body: payload.body,
        createdAt: new Date().toISOString(),
      });
      ack?.({ ok: true, id });
    } catch (err) {
      logger.error({ err }, 'message:send failed');
      ack?.({ ok: false, error: err instanceof Error ? err.message : 'insert failed' });
    }
  });
}
