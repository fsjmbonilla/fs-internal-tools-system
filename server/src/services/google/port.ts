/**
 * The seam between this platform and Google.
 *
 * Every byte exchanged with Google crosses this interface and nothing else —
 * that is what lets the whole phase be tested against a fake without a network,
 * and what keeps routes and automations free of Google client types. The real
 * implementation lives in `real.ts`; suites inject theirs with
 * `setGooglePortForTesting`.
 *
 * Methods take the *refresh token* (already decrypted by `googleService`),
 * never an account row: the port knows Google, not our database.
 */

export interface ExchangeResult {
  /** Null when Google did not issue one — the caller treats that as a failed connect. */
  refreshToken: string | null;
  /** The Google account's email, from the id_token. */
  email: string | null;
}

export interface CalendarEventInput {
  title: string;
  /** ISO 8601. All-day events use date-only strings on both ends. */
  start: string;
  end: string;
  attendees?: string[];
  description?: string;
  location?: string;
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

export interface GmailListItem {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  /** ISO 8601, from Gmail's internalDate. */
  date: string;
  unread: boolean;
}

export interface GmailMessage extends GmailListItem {
  to: string;
  /** Raw text/plain part, when the message has one. */
  bodyText: string | null;
  /** Raw text/html part — HOSTILE INPUT, sanitized by gmailService before any response. */
  bodyHtml: string | null;
}

export interface GmailListResult {
  messages: GmailListItem[];
  nextPageToken: string | null;
}

/** What the support-mailbox poller needs, and nothing more. */
export interface IngestEmail {
  id: string;
  /** Gmail's internalDate in ms — the watermark is in Gmail's clock, not ours. */
  internalDate: number;
  from: string;
  subject: string;
  snippet: string;
}

export interface GooglePort {
  exchangeCode(code: string): Promise<ExchangeResult>;
  revoke(refreshToken: string): Promise<void>;

  listEvents(refreshToken: string, fromIso: string, toIso: string): Promise<CalendarEvent[]>;
  createEvent(refreshToken: string, input: CalendarEventInput): Promise<CalendarEvent>;

  listMail(
    refreshToken: string,
    opts: { q?: string; labelId?: string; pageToken?: string },
  ): Promise<GmailListResult>;
  getMail(refreshToken: string, id: string): Promise<GmailMessage | null>;
  sendMail(
    refreshToken: string,
    input: { to: string; subject: string; body: string },
  ): Promise<{ id: string }>;
  /** Inbox messages strictly newer than the watermark, oldest first. */
  listMailSince(refreshToken: string, afterInternalDate: number): Promise<IngestEmail[]>;
}

let activePort: GooglePort | null = null;

export function getGooglePort(): GooglePort {
  if (!activePort) {
    throw new Error(
      'No Google port installed — index.ts installs the real one at boot; tests inject a fake',
    );
  }
  return activePort;
}

export function setGooglePort(port: GooglePort): void {
  activePort = port;
}

/** Test hook. Returns the previous port so a suite can restore it. */
export function setGooglePortForTesting(port: GooglePort | null): GooglePort | null {
  const previous = activePort;
  activePort = port;
  return previous;
}
