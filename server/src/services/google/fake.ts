import type {
  CalendarEvent,
  CalendarEventInput,
  DriveFile,
  GmailListItem,
  GmailMessage,
  GooglePort,
  IngestEmail,
} from './port.js';

/**
 * The fake Google every suite injects. In-memory, deterministic, and able to
 * misbehave on demand: `failWith('invalid_grant')` makes the next call die the
 * way a revoked grant dies, which is the path most worth testing.
 *
 * Not a .test.ts file — it holds no assertions, only the double.
 */

export class InvalidGrantError extends Error {
  readonly response = { data: { error: 'invalid_grant' } };
  constructor() {
    super('invalid_grant');
  }
}

/** What Google answers when the grant predates a scope the call needs. */
export class InsufficientScopeError extends Error {
  readonly status = 403;
  readonly errors = [{ reason: 'insufficientPermissions' }];
  constructor() {
    super('Insufficient Permission: Request had insufficient authentication scopes.');
  }
}

/** A fake Drive entry: the file plus which folder holds it. */
export interface FakeDriveEntry extends DriveFile {
  parentId: string;
  /** True when someone else shared this file with the connected account. */
  sharedWithMe: boolean;
}

export interface FakeGoogle extends GooglePort {
  /** Arm every subsequent call (not exchangeCode) to reject as a dead grant. */
  breakGrant(): void;
  /** Arm Drive calls to fail the way a pre-Drive grant fails (scope 403). */
  breakDriveScope(): void;
  /** What exchangeCode hands back next. */
  nextExchange: { refreshToken: string | null; email: string | null };
  events: CalendarEvent[];
  /** `internalDate` drives listMailItemsSince; derived from `date` when omitted. */
  inbox: Array<GmailMessage & { internalDate?: number }>;
  ingest: IngestEmail[];
  sent: Array<{ to: string; cc?: string; subject: string; body: string; threadId?: string }>;
  /** Message ids marked read via markMailRead. */
  readMarks: string[];
  /** Drafts saved via createDraft. */
  drafts: Array<{ to: string; subject: string; body: string; threadId?: string }>;
  revoked: string[];
  drive: FakeDriveEntry[];
  /** Content written via uploadDriveFile/updateDriveFile, by file id. */
  uploads: Map<string, Buffer>;
  /** Grants made via shareDriveFile. */
  shares: Array<{ fileId: string; email: string; role: 'reader' | 'writer' }>;
  /** Convenience: add a file/folder to the fake Drive. */
  addDriveFile(input: Partial<FakeDriveEntry> & { name: string }): FakeDriveEntry;
}

let seq = 0;

export function makeFakeGoogle(): FakeGoogle {
  let grantBroken = false;
  let driveScopeBroken = false;
  const fake: FakeGoogle = {
    nextExchange: { refreshToken: 'fake-refresh-token', email: 'connected@flowerstore.ph' },
    events: [],
    inbox: [],
    ingest: [],
    sent: [],
    readMarks: [],
    drafts: [],
    revoked: [],
    drive: [],
    uploads: new Map(),
    shares: [],

    breakGrant() {
      grantBroken = true;
    },

    breakDriveScope() {
      driveScopeBroken = true;
    },

    addDriveFile(input) {
      const entry: FakeDriveEntry = {
        id: input.id ?? `df_${++seq}`,
        name: input.name,
        mimeType: input.mimeType ?? 'application/pdf',
        isFolder: input.isFolder ?? false,
        webViewLink: input.webViewLink ?? `https://drive.google.com/file/d/df_${seq}/view`,
        sizeBytes: input.sizeBytes ?? 1024,
        modifiedAt: input.modifiedAt ?? '2026-08-06T00:00:00.000Z',
        owner: input.owner ?? 'connected@flowerstore.ph',
        thumbnailLink: input.thumbnailLink ?? null,
        shared: input.shared ?? false,
        imageWidth: input.imageWidth ?? null,
        imageHeight: input.imageHeight ?? null,
        parentId: input.parentId ?? 'root',
        sharedWithMe: input.sharedWithMe ?? false,
      };
      fake.drive.push(entry);
      return entry;
    },

    async exchangeCode(code: string) {
      if (code === 'bad-code') throw new Error('invalid_grant');
      return { ...fake.nextExchange };
    },

    async revoke(refreshToken: string) {
      fake.revoked.push(refreshToken);
    },

    async listEvents(_t: string, fromIso: string, toIso: string) {
      if (grantBroken) throw new InvalidGrantError();
      return fake.events.filter((e) => e.start >= fromIso && e.start <= toIso);
    },

    async createEvent(_t: string, input: CalendarEventInput) {
      if (grantBroken) throw new InvalidGrantError();
      const event: CalendarEvent = {
        id: `evt_${++seq}`,
        title: input.title,
        start: input.start,
        end: input.end,
        allDay: false,
        attendees: input.attendees ?? [],
        location: input.location ?? null,
        description: input.description ?? null,
        htmlLink: `https://calendar.google.com/event?eid=evt_${seq}`,
      };
      fake.events.push(event);
      return event;
    },

    async listMail(_t: string, opts: { q?: string; pageToken?: string }) {
      if (grantBroken) throw new InvalidGrantError();
      const matches = (m: GmailListItem) =>
        !opts.q || `${m.from} ${m.subject} ${m.snippet}`.includes(opts.q);
      return { messages: fake.inbox.filter(matches), nextPageToken: null };
    },

    async getMail(_t: string, id: string) {
      if (grantBroken) throw new InvalidGrantError();
      return fake.inbox.find((m) => m.id === id) ?? null;
    },

    async sendMail(_t: string, input: { to: string; subject: string; body: string }) {
      if (grantBroken) throw new InvalidGrantError();
      fake.sent.push(input);
      return { id: `sent_${++seq}` };
    },

    async listMailSince(_t: string, afterInternalDate: number) {
      if (grantBroken) throw new InvalidGrantError();
      return fake.ingest
        .filter((m) => m.internalDate > afterInternalDate)
        .sort((a, b) => a.internalDate - b.internalDate);
    },

    async listMailItemsSince(_t: string, afterInternalDate: number) {
      if (grantBroken) throw new InvalidGrantError();
      return fake.inbox
        .map((m) => ({
          id: m.id,
          threadId: m.threadId,
          from: m.from,
          subject: m.subject,
          snippet: m.snippet,
          date: m.date,
          unread: m.unread,
          internalDate: m.internalDate ?? Date.parse(m.date),
        }))
        .filter((m) => m.internalDate > afterInternalDate)
        .sort((a, b) => a.internalDate - b.internalDate);
    },

    async replyMail(_t: string, input: { messageId: string; body: string; all?: boolean }) {
      if (grantBroken) throw new InvalidGrantError();
      const original = fake.inbox.find((m) => m.id === input.messageId);
      if (!original) throw new Error('original message not found');
      const subject = /^re:/i.test(original.subject)
        ? original.subject
        : `Re: ${original.subject}`;
      fake.sent.push({
        to: original.from,
        ...(input.all && original.to ? { cc: original.to } : {}),
        subject,
        body: input.body,
        threadId: original.threadId,
      });
      return { id: `sent_${++seq}` };
    },

    async createDraft(
      _t: string,
      input: { to?: string; subject?: string; body: string; replyToMessageId?: string },
    ) {
      if (grantBroken) throw new InvalidGrantError();
      if (input.replyToMessageId) {
        const original = fake.inbox.find((m) => m.id === input.replyToMessageId);
        if (!original) throw new Error('original message not found');
        const subject = /^re:/i.test(original.subject)
          ? original.subject
          : `Re: ${original.subject}`;
        fake.drafts.push({
          to: original.from,
          subject,
          body: input.body,
          threadId: original.threadId,
        });
      } else {
        fake.drafts.push({ to: input.to ?? '', subject: input.subject ?? '', body: input.body });
      }
      return { id: `draft_${++seq}` };
    },

    async markMailRead(_t: string, messageId: string) {
      if (grantBroken) throw new InvalidGrantError();
      const msg = fake.inbox.find((m) => m.id === messageId);
      if (msg) msg.unread = false;
      fake.readMarks.push(messageId);
    },

    async listDriveFiles(
      _t: string,
      opts: { folderId?: string; q?: string; sharedWithMe?: boolean },
    ) {
      if (grantBroken) throw new InvalidGrantError();
      if (driveScopeBroken) throw new InsufficientScopeError();
      // Same precedence as the real port: sharedWithMe, then search, then browse.
      const files = opts.sharedWithMe
        ? fake.drive.filter((f) => f.sharedWithMe)
        : opts.q
          ? fake.drive.filter((f) => f.name.includes(opts.q!))
          : fake.drive.filter((f) => f.parentId === (opts.folderId ?? 'root'));
      return {
        files: files.map(({ parentId: _p, sharedWithMe: _s, ...f }) => f),
        nextPageToken: null,
      };
    },

    async getDriveFile(_t: string, fileId: string) {
      if (grantBroken) throw new InvalidGrantError();
      if (driveScopeBroken) throw new InsufficientScopeError();
      const found = fake.drive.find((f) => f.id === fileId);
      if (!found) return null;
      const { parentId: _p, sharedWithMe: _s, ...file } = found;
      return file;
    },

    async uploadDriveFile(
      _t: string,
      input: { folderId: string; name: string; mimeType: string; data: Buffer },
    ) {
      if (grantBroken) throw new InvalidGrantError();
      if (driveScopeBroken) throw new InsufficientScopeError();
      const { parentId: _p, sharedWithMe: _s, ...file } = fake.addDriveFile({
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.data.length,
        parentId: input.folderId,
      });
      fake.uploads.set(file.id, input.data);
      return file;
    },

    async ensureDriveFolder(_t: string, name: string) {
      if (grantBroken) throw new InvalidGrantError();
      if (driveScopeBroken) throw new InsufficientScopeError();
      const existing = fake.drive.find(
        (f) => f.isFolder && f.name === name && f.parentId === 'root',
      );
      if (existing) return { id: existing.id };
      const folder = fake.addDriveFile({
        name,
        isFolder: true,
        mimeType: 'application/vnd.google-apps.folder',
        parentId: 'root',
      });
      return { id: folder.id };
    },

    async updateDriveFile(
      _t: string,
      fileId: string,
      input: { name: string; mimeType: string; data: Buffer },
    ) {
      if (grantBroken) throw new InvalidGrantError();
      if (driveScopeBroken) throw new InsufficientScopeError();
      const file = fake.drive.find((f) => f.id === fileId);
      if (!file) {
        const err = new Error('not found') as Error & { status: number };
        err.status = 404;
        throw err;
      }
      file.name = input.name;
      fake.uploads.set(fileId, input.data);
    },

    async moveDriveFile(_t: string, fileId: string, toFolderId: string) {
      if (grantBroken) throw new InvalidGrantError();
      if (driveScopeBroken) throw new InsufficientScopeError();
      const file = fake.drive.find((f) => f.id === fileId);
      if (!file) {
        const err = new Error('not found') as Error & { status: number };
        err.status = 404;
        throw err;
      }
      file.parentId = toFolderId;
    },

    async shareDriveFile(
      _t: string,
      fileId: string,
      input: { email: string; role: 'reader' | 'writer' },
    ) {
      if (grantBroken) throw new InvalidGrantError();
      if (driveScopeBroken) throw new InsufficientScopeError();
      if (!fake.drive.some((f) => f.id === fileId)) {
        const err = new Error('not found') as Error & { status: number };
        err.status = 404;
        throw err;
      }
      fake.shares.push({ fileId, ...input });
    },

    async exportDriveFile(_t: string, fileId: string) {
      if (grantBroken) throw new InvalidGrantError();
      if (driveScopeBroken) throw new InsufficientScopeError();
      const file = fake.drive.find((f) => f.id === fileId);
      if (!file) return null;
      const native: Record<string, { mimeType: string; ext: string }> = {
        'application/vnd.google-apps.document': {
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ext: 'docx',
        },
        'application/vnd.google-apps.spreadsheet': {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ext: 'xlsx',
        },
        'application/vnd.google-apps.presentation': { mimeType: 'application/pdf', ext: 'pdf' },
      };
      const mapped = native[file.mimeType];
      if (mapped) {
        return {
          name: `${file.name}.${mapped.ext}`,
          mimeType: mapped.mimeType,
          data: fake.uploads.get(fileId) ?? Buffer.from(`export of ${file.name}`),
        };
      }
      if (file.mimeType.startsWith('application/vnd.google-apps.')) return null;
      return {
        name: file.name,
        mimeType: file.mimeType,
        data: fake.uploads.get(fileId) ?? Buffer.from(`bytes of ${file.name}`),
      };
    },
  };
  return fake;
}
