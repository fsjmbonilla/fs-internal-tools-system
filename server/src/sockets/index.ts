import type { Server } from 'socket.io';
import { socketAuth } from './authMiddleware.js';
import { registerChatHandlers } from './chatHandlers.js';

export function registerSocketHandlers(io: Server): void {
  io.use(socketAuth);
  io.on('connection', (socket) => {
    registerChatHandlers(io, socket);
  });
}
