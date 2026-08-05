import { eq } from 'drizzle-orm';
import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { endCall, getCallById, startCall } from '../services/callService.js';
import { getVisibleChannel, isChannelMember } from '../services/channelService.js';
import { isLiveKitConfigured, mintCallToken } from '../services/livekitService.js';

export const callsRouter = Router();
// User-only: a bot joining a video call is not a feature yet, and a LiveKit join
// grant is a credential worth not minting for a long-lived token.
callsRouter.use(requireAuth, requireUserAuth);

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

async function requireCallerCanUseChannel(channelId: number, userId: number, isAdmin: boolean) {
  const channel = await getVisibleChannel(channelId, userId, isAdmin);
  if (!channel || (!isAdmin && !(await isChannelMember(channelId, userId)))) {
    throw new AppError(404, 'not_found', 'Not found');
  }
}

const startBody = z.object({ channelId: z.number().int().positive().optional() });

callsRouter.post('/', validate(startBody), async (req, res) => {
  if (!isLiveKitConfigured()) {
    throw new AppError(503, 'calls_not_configured', 'Teleconference is not configured');
  }
  const { channelId } = req.valid as z.infer<typeof startBody>;
  const userId = req.auth!.userId;
  const isAdmin = req.auth!.role === 'admin';

  if (channelId !== undefined) {
    await requireCallerCanUseChannel(channelId, userId, isAdmin);
  }

  const call = await startCall(channelId ?? null, userId);
  const [user] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId));
  const token = await mintCallToken(call.roomName, String(userId), user?.displayName ?? String(userId));

  if (channelId !== undefined) {
    const io = req.app.get('io') as SocketIOServer | undefined;
    io?.to(`channel:${channelId}`).emit('call:started', { channelId, callId: call.id, roomName: call.roomName });
  }

  res.status(201).json({ call, token, serverUrl: config.LIVEKIT_URL });
});

callsRouter.post('/:id/end', async (req, res) => {
  const id = parseId(req.params.id);
  const existing = await getCallById(id);
  if (!existing) throw new AppError(404, 'not_found', 'Not found');

  const userId = req.auth!.userId;
  const isAdmin = req.auth!.role === 'admin';
  if (existing.channelId !== null) {
    await requireCallerCanUseChannel(existing.channelId, userId, isAdmin);
  } else if (existing.startedBy !== userId && !isAdmin) {
    throw new AppError(404, 'not_found', 'Not found');
  }

  const updated = await endCall(id);
  if (!updated) throw new AppError(400, 'already_ended', 'Call already ended');

  if (updated.channelId !== null) {
    const io = req.app.get('io') as SocketIOServer | undefined;
    io?.to(`channel:${updated.channelId}`).emit('call:ended', {
      channelId: updated.channelId,
      callId: updated.id,
    });
  }

  res.json({ ok: true });
});
