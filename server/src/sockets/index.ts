import type { Server } from 'socket.io';
import { markOffline, markOnline } from '../services/presence.js';
import { registerAccessHandlers } from './accessHandlers.js';
import { socketAuth } from './authMiddleware.js';
import { registerChatHandlers } from './chatHandlers.js';
import { registerSheetHandlers } from './sheetHandlers.js';

export function registerSocketHandlers(io: Server): void {
  io.use(socketAuth);
  // Once per process, not per connection: these listen on the service event bus
  // for revocations and act on every affected socket.
  registerAccessHandlers(io);
  io.on('connection', (socket) => {
    markOnline(socket.data.userId);
    socket.on('disconnect', () => markOffline(socket.data.userId));
    registerChatHandlers(io, socket);
    registerSheetHandlers(io, socket);
  });
}
