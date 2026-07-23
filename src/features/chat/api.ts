import { api } from '@/lib/api';
import type { Channel, Message } from './types';

export const listChannels = () => api<{ channels: Channel[] }>('/api/channels');

export const createChannel = (input: {
  name: string;
  isPrivate: boolean;
  topic?: string;
  departmentId?: number;
}) => api<{ channel: Channel }>('/api/channels', { method: 'POST', body: input });

export const getChannel = (id: number) => api<{ channel: Channel }>(`/api/channels/${id}`);

export const getMessages = (channelId: number, before?: number, limit = 50) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', String(before));
  return api<{ messages: Message[] }>(`/api/channels/${channelId}/messages?${params}`);
};

export const markRead = (channelId: number, messageId: number) =>
  api(`/api/channels/${channelId}/read`, { method: 'POST', body: { messageId } });

export const createDm = (userId: number) =>
  api<{ channel: Channel }>('/api/dms', { method: 'POST', body: { userId } });

export const listMyDms = () => api<{ dms: { id: number; dmKey: string | null }[] }>('/api/dms');

export const searchMessages = (q: string, channelId?: number) => {
  const params = new URLSearchParams({ q });
  if (channelId) params.set('channelId', String(channelId));
  return api<{ messages: Message[] }>(`/api/search/messages?${params}`);
};

export const editMessageRest = (id: number, body: string) =>
  api(`/api/messages/${id}`, { method: 'PATCH', body: { body } });

export const deleteMessageRest = (id: number) => api(`/api/messages/${id}`, { method: 'DELETE' });
