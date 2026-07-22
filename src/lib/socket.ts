import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '@/features/auth/authStore';

// In production (ECS behind a load balancer) the socket server shares the app's
// origin, so no URL is needed; locally, point at the dev server.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4000';

export interface ChatMessage {
  id: number;
  channelId: number;
  userId: number;
  body: string;
  createdAt: string;
}

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    // autoConnect off: chat connects after login (Phase 2); the auth callback
    // supplies the current access token on every (re)connect.
    socket = io(SERVER_URL, {
      autoConnect: false,
      auth: (cb) => cb({ token: useAuthStore.getState().accessToken }),
    });
  }
  return socket;
}

export function joinChannel(channelId: number): void {
  getSocket().emit('channel:join', channelId);
}

export function leaveChannel(channelId: number): void {
  getSocket().emit('channel:leave', channelId);
}

export function sendMessage(
  message: Pick<ChatMessage, 'channelId' | 'body'>,
): Promise<{ ok: boolean; id?: number; error?: string }> {
  // author identity comes from the server-side socket auth, never the payload
  return getSocket().emitWithAck('message:send', message);
}

export function onNewMessage(handler: (message: ChatMessage) => void): () => void {
  const s = getSocket();
  s.on('message:new', handler);
  return () => s.off('message:new', handler);
}
