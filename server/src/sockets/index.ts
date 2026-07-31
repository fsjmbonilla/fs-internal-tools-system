import type { Server } from 'socket.io';
import { markOffline, markOnline } from '../services/presence.js';
import { socketAuth } from './authMiddleware.js';
import { registerChatHandlers } from './chatHandlers.js';

export function registerSocketHandlers(io: Server): void {
  io.use(socketAuth);
  io.on('connection', (socket) => {
    markOnline(socket.data.userId);
    socket.on('disconnect', () => markOffline(socket.data.userId));
    registerChatHandlers(io, socket);
  });
}
