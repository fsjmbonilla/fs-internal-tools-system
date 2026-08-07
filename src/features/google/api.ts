import { api, ApiError } from '@/lib/api';

/** Is this error the "no working Google connection" 409 from the API? */
export function isGoogleConnectionError(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    (err.code === 'google_not_connected' ||
      err.code === 'google_connection_broken' ||
      err.code === 'google_not_configured')
  );
}

export interface ConnectionStatus {
  connected: boolean;
  email: string | null;
  broken: boolean;
}

export interface GoogleStatus {
  configured: boolean;
  user: ConnectionStatus;
  /** Present only for admins. */
  supportMailbox?: ConnectionStatus;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  attendees: string[];
  location: string | null;
  description: string | null;
  htmlLink: string | null;
}

export interface CalendarEventInput {
  title: string;
  start: string;
  end: string;
  attendees?: string[];
  description?: string;
  location?: string;
}

export interface GmailListItem {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
}

export interface GmailMessage extends GmailListItem {
  to: string;
  bodyText: string | null;
  /** Sanitized server-side; safe to render. */
  bodyHtml: string | null;
}

export interface MailboxBinding extends ConnectionStatus {
  targetChannelId: number | null;
}

export const getGoogleStatus = () => api<GoogleStatus>('/api/google/status');

export const getGoogleAuthUrl = (kind: 'user' | 'support_mailbox' = 'user') =>
  api<{ url: string }>(`/api/google/auth-url?kind=${kind}`);

export const disconnectGoogle = (kind: 'user' | 'support_mailbox' = 'user') =>
  api<{ ok: boolean }>(`/api/google/connection?kind=${kind}`, { method: 'DELETE' });

export const listCalendarEvents = (fromIso: string, toIso: string) =>
  api<{ events: CalendarEvent[] }>(
    `/api/calendar/events?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
  );

export const createCalendarEvent = (input: CalendarEventInput) =>
  api<{ event: CalendarEvent }>('/api/calendar/events', { method: 'POST', body: input });

export const listGmail = (opts: { q?: string; pageToken?: string } = {}) => {
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.pageToken) params.set('pageToken', opts.pageToken);
  const qs = params.toString();
  return api<{ messages: GmailListItem[]; nextPageToken: string | null }>(
    `/api/gmail/messages${qs ? `?${qs}` : ''}`,
  );
};

export const getGmailMessage = (id: string) =>
  api<{ message: GmailMessage }>(`/api/gmail/messages/${encodeURIComponent(id)}`);

export const sendGmail = (input: { to: string; subject: string; body: string }) =>
  api<{ sent: { id: string } }>('/api/gmail/send', { method: 'POST', body: input });

/** Reply in-thread; To/Cc/Subject/threading headers derive server-side. */
export const replyGmail = (messageId: string, body: string, all = false) =>
  api<{ sent: { id: string } }>(
    `/api/gmail/messages/${encodeURIComponent(messageId)}/reply`,
    { method: 'POST', body: { body, all } },
  );

/** Save a Gmail draft — a reply draft when replyToMessageId is set. */
export const saveGmailDraft = (input: {
  to?: string;
  subject?: string;
  body: string;
  replyToMessageId?: string;
}) => api<{ draft: { id: string } }>('/api/gmail/drafts', { method: 'POST', body: input });

/** AI-suggested reply text for a message (budget-gated server-side). */
export const draftGmailReply = (messageId: string, instruction?: string) =>
  api<{ draft: string }>(
    `/api/gmail/messages/${encodeURIComponent(messageId)}/draft-reply`,
    { method: 'POST', body: instruction ? { instruction } : {} },
  );

/** Forward the message (quoted as text) to a new recipient. */
export const forwardGmail = (messageId: string, to: string, note?: string) =>
  api<{ sent: { id: string } }>(
    `/api/gmail/messages/${encodeURIComponent(messageId)}/forward`,
    { method: 'POST', body: { to, ...(note ? { note } : {}) } },
  );

export const getMailboxBinding = () =>
  api<MailboxBinding>('/api/admin/google/support-mailbox');

export const bindMailbox = (targetChannelId: number) =>
  api<{ ok: boolean }>('/api/admin/google/support-mailbox', {
    method: 'PUT',
    body: { targetChannelId },
  });

export const unbindMailbox = () =>
  api<{ ok: boolean }>('/api/admin/google/support-mailbox', { method: 'DELETE' });
