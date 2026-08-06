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
}

export interface FakeGoogle extends GooglePort {
  /** Arm every subsequent call (not exchangeCode) to reject as a dead grant. */
  breakGrant(): void;
  /** Arm Drive calls to fail the way a pre-Drive grant fails (scope 403). */
  breakDriveScope(): void;
  /** What exchangeCode hands back next. */
  nextExchange: { refreshToken: string | null; email: string | null };
  events: CalendarEvent[];
  inbox: GmailMessage[];
  ingest: IngestEmail[];
  sent: Array<{ to: string; subject: string; body: string }>;
  revoked: string[];
  drive: FakeDriveEntry[];
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
    revoked: [],
    drive: [],

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
        parentId: input.parentId ?? 'root',
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

    async listDriveFiles(_t: string, opts: { folderId?: string; q?: string }) {
      if (grantBroken) throw new InvalidGrantError();
      if (driveScopeBroken) throw new InsufficientScopeError();
      const files = opts.q
        ? fake.drive.filter((f) => f.name.includes(opts.q!))
        : fake.drive.filter((f) => f.parentId === (opts.folderId ?? 'root'));
      return { files: files.map(({ parentId: _p, ...f }) => f), nextPageToken: null };
    },

    async getDriveFile(_t: string, fileId: string) {
      if (grantBroken) throw new InvalidGrantError();
      if (driveScopeBroken) throw new InsufficientScopeError();
      const found = fake.drive.find((f) => f.id === fileId);
      if (!found) return null;
      const { parentId: _p, ...file } = found;
      return file;
    },

    async uploadDriveFile(
      _t: string,
      input: { folderId: string; name: string; mimeType: string; data: Buffer },
    ) {
      if (grantBroken) throw new InvalidGrantError();
      if (driveScopeBroken) throw new InsufficientScopeError();
      const { parentId: _p, ...file } = fake.addDriveFile({
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.data.length,
        parentId: input.folderId,
      });
      return file;
    },
  };
  return fake;
}
