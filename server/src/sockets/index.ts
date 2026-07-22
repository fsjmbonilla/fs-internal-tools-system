import type { Server } from 'socket.io';
import { registerChatHandlers } from './chatHandlers.js';

export function registerSocketHandlers(io: Server): void {
  io.on('connection', (socket) => {
    registerChatHandlers(io, socket);
  });
}
