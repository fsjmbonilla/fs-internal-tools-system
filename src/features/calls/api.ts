import { api } from '@/lib/api';
import type { Call, StartCallResponse } from './types';

export const startCall = (channelId?: number) =>
  api<StartCallResponse>('/api/calls', { method: 'POST', body: { channelId } });

export const endCall = (callId: number) => api(`/api/calls/${callId}/end`, { method: 'POST' });

export const getActiveCall = (channelId: number) =>
  api<{ call: Call | null }>(`/api/channels/${channelId}/call`);
