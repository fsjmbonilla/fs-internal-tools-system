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

export interface DriveFile {
  id: string;
  name: string;
  /** Drive's mime — Google-native files (Docs/Sheets) have vnd.google-apps.* */
  mimeType: string;
  isFolder: boolean;
  webViewLink: string | null;
  /** Bytes, when Drive knows (Google-native files have no size). */
  sizeBytes: number | null;
  modifiedAt: string | null;
  owner: string | null;
  /** Short-lived signed URL for a small preview image, when Drive has one. */
  thumbnailLink: string | null;
  /** Whether the file is shared with anyone beyond the owner. */
  shared: boolean;
  /** Pixel dimensions, images only. */
  imageWidth: number | null;
  imageHeight: number | null;
}

export interface DriveListResult {
  files: DriveFile[];
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
  /**
   * Like listMailSince but in list-item shape, for the per-user inbox cache.
   * `afterInternalDate === 0` means "seed": return the most recent page instead
   * of everything ever.
   */
  listMailItemsSince(
    refreshToken: string,
    afterInternalDate: number,
  ): Promise<Array<GmailListItem & { internalDate: number }>>;
  /**
   * Reply within the message's thread. To/Subject/In-Reply-To/References are
   * derived from the original message; the caller supplies only the body.
   * `all` additionally Cc's every original To/Cc recipient except ourselves.
   */
  replyMail(
    refreshToken: string,
    input: { messageId: string; body: string; all?: boolean },
  ): Promise<{ id: string }>;
  /** Clear the UNREAD label. Requires gmail.modify — callers absorb scope 403s. */
  markMailRead(refreshToken: string, messageId: string): Promise<void>;
  /**
   * Save a Gmail draft. With `replyToMessageId`, headers and thread derive
   * from the original (like replyMail); otherwise it's a fresh compose draft.
   */
  createDraft(
    refreshToken: string,
    input: { to?: string; subject?: string; body: string; replyToMessageId?: string },
  ): Promise<{ id: string }>;

  /**
   * Browse a folder (folderId, 'root' by default), search by name/content (q),
   * or list what others shared with this account (sharedWithMe, most recently
   * shared first). The three modes are exclusive; sharedWithMe wins.
   */
  listDriveFiles(
    refreshToken: string,
    opts: { folderId?: string; q?: string; pageToken?: string; sharedWithMe?: boolean },
  ): Promise<DriveListResult>;
  getDriveFile(refreshToken: string, fileId: string): Promise<DriveFile | null>;
  uploadDriveFile(
    refreshToken: string,
    input: { folderId: string; name: string; mimeType: string; data: Buffer },
  ): Promise<DriveFile>;
  /**
   * Find (by exact name, in the Drive root) or create a folder. Under the
   * drive.file scope a search only sees what this app created — which is
   * exactly the folder this method manages.
   */
  ensureDriveFolder(refreshToken: string, name: string): Promise<{ id: string }>;
  /** Overwrite an existing file's name and content. */
  updateDriveFile(
    refreshToken: string,
    fileId: string,
    input: { name: string; mimeType: string; data: Buffer },
  ): Promise<void>;
  /**
   * The file's bytes, for in-app rendering. Google-native files are exported
   * (Docs → docx, Sheets → xlsx, Slides → pdf); anything else downloads as-is.
   * Null when the file does not exist or has no exportable form.
   */
  exportDriveFile(
    refreshToken: string,
    fileId: string,
  ): Promise<{ name: string; mimeType: string; data: Buffer } | null>;
  /** Re-parent a file: out of its current folder(s), into `toFolderId`. */
  moveDriveFile(refreshToken: string, fileId: string, toFolderId: string): Promise<void>;
  /** Grant one Google account access to a file the caller owns. */
  shareDriveFile(
    refreshToken: string,
    fileId: string,
    input: { email: string; role: 'reader' | 'writer' },
  ): Promise<void>;
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
