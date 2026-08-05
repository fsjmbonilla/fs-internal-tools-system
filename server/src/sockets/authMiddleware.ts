import { eq } from 'drizzle-orm';
import type { Socket } from 'socket.io';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { logger } from '../logger.js';
import { verifyAccessToken } from '../services/tokenService.js';

/** Grace period past expiry, so a client mid-refresh is not cut off abruptly. */
const EXPIRY_GRACE_MS = 30_000;

export async function socketAuth(socket: Socket, next: (err?: Error) => void): Promise<void> {
  const token = socket.handshake.auth?.token as string | undefined;
  const claims = token ? await verifyAccessToken(token) : null;
  if (!claims) return next(new Error('unauthenticated'));

  // One lookup per connection (not per event) closes the reconnect loophole: a
  // deactivated user still holds a valid token for up to its lifetime, and
  // without this they could simply reconnect after being disconnected.
  const [user] = await db
    .select({ isActive: users.isActive, role: users.role })
    .from(users)
    .where(eq(users.id, claims.userId));
  if (!user || !user.isActive) return next(new Error('unauthenticated'));

  socket.data.userId = claims.userId;
  // The stored role wins over the token's: a demotion that happened after this
  // token was issued must apply to the connection it opens.
  socket.data.role = user.role;
  socket.data.expiresAt = claims.expiresAt;

  // The handshake is the only place these credentials are ever checked, so the
  // connection must not outlive them. Without this a socket kept receiving
  // messages long after its token expired, and kept the role it held at connect
  // time even after being demoted.
  scheduleExpiry(socket, claims.expiresAt);
  await socket.join(`user:${claims.userId}`);
  next();
}

function scheduleExpiry(socket: Socket, expiresAt: number | null): void {
  if (!expiresAt) return;
  const ms = expiresAt * 1000 - Date.now() + EXPIRY_GRACE_MS;
  if (ms <= 0) {
    socket.disconnect(true);
    return;
  }
  const timer = setTimeout(() => {
    logger.debug({ userId: socket.data.userId }, 'socket token expired, disconnecting');
    // The client's auth callback hands over a fresh token on reconnect, so this
    // costs one silent reconnect per token lifetime.
    socket.emit('auth:expired');
    socket.disconnect(true);
  }, ms);
  // Otherwise Node keeps the process alive for a timer on a dead socket.
  timer.unref?.();
  socket.on('disconnect', () => clearTimeout(timer));
}
