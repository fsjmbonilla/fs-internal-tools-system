import { io, type Socket } from 'socket.io-client';

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
    socket = io(SERVER_URL, { autoConnect: true });
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
  message: Pick<ChatMessage, 'channelId' | 'userId' | 'body'>,
): Promise<{ ok: boolean; id?: number; error?: string }> {
  return getSocket().emitWithAck('message:send', message);
}

export function onNewMessage(handler: (message: ChatMessage) => void): () => void {
  const s = getSocket();
  s.on('message:new', handler);
  return () => s.off('message:new', handler);
}
