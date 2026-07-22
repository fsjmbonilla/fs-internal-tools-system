import type { Socket } from 'socket.io';
import { verifyAccessToken } from '../services/tokenService.js';

export async function socketAuth(socket: Socket, next: (err?: Error) => void): Promise<void> {
  const token = socket.handshake.auth?.token as string | undefined;
  const claims = token ? await verifyAccessToken(token) : null;
  if (!claims) return next(new Error('unauthenticated'));
  socket.data.userId = claims.userId;
  socket.data.role = claims.role;
  await socket.join(`user:${claims.userId}`);
  next();
}
