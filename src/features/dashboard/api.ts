import { api } from '@/lib/api';
import type { DriveFile } from '@/features/drive/api';
import type { CalendarEvent } from '@/features/google/api';

export interface UnreadChannelEntry {
  id: number;
  name: string;
  kind: 'standard' | 'support';
  unreadCount: number;
}

export interface UnreadDmEntry {
  id: number;
  displayName: string;
  unreadCount: number;
}

export interface NewTicketEntry {
  id: number;
  title: string;
  projectId: number;
  projectName: string;
  columnName: string | null;
}

export interface NewProjectEntry {
  id: number;
  name: string;
  isPrivate: boolean;
}

export interface TodayDashboard {
  /** Null when the caller has no usable Google connection. */
  events: CalendarEvent[] | null;
  /** Null when the caller has no usable Google connection. */
  sharedFiles: DriveFile[] | null;
  unread: { channels: UnreadChannelEntry[]; dms: UnreadDmEntry[] };
  newTickets: NewTicketEntry[];
  newProjects: NewProjectEntry[];
}

export const getToday = () => api<TodayDashboard>('/api/dashboard/today');

/** A paid AI call — only ever fired by an explicit user action. */
export const summarizeDay = () =>
  api<{ summary: string }>('/api/dashboard/summary', { method: 'POST', body: {} });
