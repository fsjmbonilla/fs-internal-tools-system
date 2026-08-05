import type { Server } from 'socket.io';
import { logger } from '../logger.js';
import { events } from '../services/events.js';

/**
 * Push access revocation to live connections.
 *
 * A socket is authorized once, at handshake, and then joined to rooms. Nothing
 * re-checks it, so losing access has to be pushed: without this a removed member
 * kept receiving a private channel's messages until they reconnected, and a
 * deactivated user kept a working session until their token expired.
 *
 * Registered once per process, against the one io instance.
 */
export function registerAccessHandlers(io: Server): void {
  events.on('access.channelRevoked', ({ userId, channelId }) => {
    // Every one of that user's sockets (they may have several devices) leaves
    // just this channel's room; the connection itself stays up.
    io.in(`user:${userId}`).socketsLeave(`channel:${channelId}`);
    io.to(`user:${userId}`).emit('channel:revoked', { channelId });
    logger.debug({ userId, channelId }, 'socket channel access revoked');
  });

  events.on('access.userSessionsInvalidated', ({ userId, reason }) => {
    io.to(`user:${userId}`).emit('auth:invalidated', { reason });
    // Disconnecting is what forces a fresh handshake: on reconnect the client
    // presents its token again and a deactivated user simply cannot get back in.
    io.in(`user:${userId}`).disconnectSockets(true);
    logger.info({ userId, reason }, 'socket sessions invalidated');
  });
}
