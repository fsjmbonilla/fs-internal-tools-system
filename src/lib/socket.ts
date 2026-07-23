import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '@/features/auth/authStore';
import type { Message } from '@/features/chat/types';

// In production (ECS behind a load balancer) the socket server shares the app's
// origin, so no URL is needed; locally, point at the dev server.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4000';

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

export function connectSocket(): void {
  getSocket().connect();
}

export function disconnectSocket(): void {
  getSocket().disconnect();
}

export function joinChannel(channelId: number): void {
  getSocket().emit('channel:join', channelId);
}

export function leaveChannel(channelId: number): void {
  getSocket().emit('channel:leave', channelId);
}

export function sendMessage(
  message: Pick<Message, 'channelId' | 'body'> & { attachmentIds?: number[] },
): Promise<{ ok: boolean; message?: Message; error?: string }> {
  // author identity comes from the server-side socket auth, never the payload
  return getSocket().emitWithAck('message:send', message);
}

export function onNewMessage(handler: (message: Message) => void): () => void {
  const s = getSocket();
  s.on('message:new', handler);
  return () => s.off('message:new', handler);
}

export function startTyping(channelId: number): void {
  getSocket().emit('typing:start', channelId);
}

export function stopTyping(channelId: number): void {
  getSocket().emit('typing:stop', channelId);
}

export function sendReaction(
  messageId: number,
  channelId: number,
  emoji: string,
): Promise<{ ok: boolean; added?: boolean; error?: string }> {
  return getSocket().emitWithAck('message:reaction', { messageId, channelId, emoji });
}

export function onReaction(
  handler: (e: { messageId: number; userId: number; emoji: string; added: boolean }) => void,
): () => void {
  const s = getSocket();
  s.on('message:reaction', handler);
  return () => s.off('message:reaction', handler);
}

export function onTyping(
  handler: (e: { channelId: number; userId: number; isTyping: boolean }) => void,
): () => void {
  const s = getSocket();
  s.on('typing', handler);
  return () => s.off('typing', handler);
}
