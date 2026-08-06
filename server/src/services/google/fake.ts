import type {
  CalendarEvent,
  CalendarEventInput,
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

export interface FakeGoogle extends GooglePort {
  /** Arm every subsequent call (not exchangeCode) to reject as a dead grant. */
  breakGrant(): void;
  /** What exchangeCode hands back next. */
  nextExchange: { refreshToken: string | null; email: string | null };
  events: CalendarEvent[];
  inbox: GmailMessage[];
  ingest: IngestEmail[];
  sent: Array<{ to: string; subject: string; body: string }>;
  revoked: string[];
}

let seq = 0;

export function makeFakeGoogle(): FakeGoogle {
  let grantBroken = false;
  const fake: FakeGoogle = {
    nextExchange: { refreshToken: 'fake-refresh-token', email: 'connected@flowerstore.ph' },
    events: [],
    inbox: [],
    ingest: [],
    sent: [],
    revoked: [],

    breakGrant() {
      grantBroken = true;
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
  };
  return fake;
}
