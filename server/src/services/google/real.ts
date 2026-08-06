import { calendar, type calendar_v3 } from '@googleapis/calendar';
import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../../config.js';
import type {
  CalendarEvent,
  CalendarEventInput,
  GmailListItem,
  GmailListResult,
  GmailMessage,
  GooglePort,
  IngestEmail,
} from './port.js';

/**
 * The real Google implementation of the port. The only file in the server that
 * talks to Google's APIs.
 *
 * The @googleapis packages each bundle their own (older) google-auth-library,
 * so the OAuth2Client we mint is passed as `auth` through a cast — the runtime
 * contract is identical, the nominal types are not.
 */

function oauthClient(refreshToken?: string): OAuth2Client {
  const client = new OAuth2Client({
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    redirectUri: config.GOOGLE_REDIRECT_URI,
  });
  if (refreshToken) client.setCredentials({ refresh_token: refreshToken });
  return client;
}

function calendarApi(refreshToken: string): calendar_v3.Calendar {
  return calendar({ version: 'v3', auth: oauthClient(refreshToken) as never });
}

function gmailApi(refreshToken: string): gmail_v1.Gmail {
  return gmail({ version: 'v1', auth: oauthClient(refreshToken) as never });
}

function toEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  const allDay = Boolean(e.start?.date);
  return {
    id: e.id ?? '',
    title: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    allDay,
    attendees: (e.attendees ?? []).map((a) => a.email ?? '').filter(Boolean),
    location: e.location ?? null,
    description: e.description ?? null,
    htmlLink: e.htmlLink ?? null,
  };
}

function header(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string {
  return payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** Walk the MIME tree for the first part of the given type. */
function findPart(
  part: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string,
): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

function toListItem(m: gmail_v1.Schema$Message): GmailListItem {
  return {
    id: m.id ?? '',
    threadId: m.threadId ?? '',
    from: header(m.payload, 'From'),
    subject: header(m.payload, 'Subject'),
    snippet: m.snippet ?? '',
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : '',
    unread: (m.labelIds ?? []).includes('UNREAD'),
  };
}

/** RFC 2047 so non-ASCII subjects survive; harmless for plain ASCII. */
function encodeSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

async function fetchMetadata(
  api: gmail_v1.Gmail,
  ids: string[],
): Promise<gmail_v1.Schema$Message[]> {
  // Sequential-ish but bounded: the list endpoints cap at 25–50 ids per call.
  const out: gmail_v1.Schema$Message[] = [];
  for (const id of ids) {
    const { data } = await api.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject'],
    });
    out.push(data);
  }
  return out;
}

export const realGooglePort: GooglePort = {
  async exchangeCode(code) {
    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    let email: string | null = null;
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.GOOGLE_CLIENT_ID,
      });
      email = ticket.getPayload()?.email ?? null;
    }
    return { refreshToken: tokens.refresh_token ?? null, email };
  },

  async revoke(refreshToken) {
    await oauthClient().revokeToken(refreshToken);
  },

  async listEvents(refreshToken, fromIso, toIso) {
    const { data } = await calendarApi(refreshToken).events.list({
      calendarId: 'primary',
      timeMin: fromIso,
      timeMax: toIso,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    });
    return (data.items ?? []).map(toEvent);
  },

  async createEvent(refreshToken, input: CalendarEventInput) {
    const { data } = await calendarApi(refreshToken).events.insert({
      calendarId: 'primary',
      sendUpdates: input.attendees?.length ? 'all' : 'none',
      requestBody: {
        summary: input.title,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
        attendees: input.attendees?.map((email) => ({ email })),
        description: input.description,
        location: input.location,
      },
    });
    return toEvent(data);
  },

  async listMail(refreshToken, opts): Promise<GmailListResult> {
    const api = gmailApi(refreshToken);
    const { data } = await api.users.messages.list({
      userId: 'me',
      q: opts.q,
      labelIds: [opts.labelId ?? 'INBOX'],
      pageToken: opts.pageToken,
      maxResults: 25,
    });
    const ids = (data.messages ?? []).map((m) => m.id ?? '').filter(Boolean);
    const metas = await fetchMetadata(api, ids);
    return { messages: metas.map(toListItem), nextPageToken: data.nextPageToken ?? null };
  },

  async getMail(refreshToken, id): Promise<GmailMessage | null> {
    try {
      const { data } = await gmailApi(refreshToken).users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      });
      return {
        ...toListItem(data),
        to: header(data.payload, 'To'),
        bodyText:
          findPart(data.payload, 'text/plain') ??
          (data.payload?.mimeType === 'text/plain' && data.payload.body?.data
            ? Buffer.from(data.payload.body.data, 'base64url').toString('utf8')
            : null),
        bodyHtml: findPart(data.payload, 'text/html'),
      };
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  },

  async sendMail(refreshToken, { to, subject, body }) {
    const mime = [
      `To: ${to}`,
      `Subject: ${encodeSubject(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      body,
    ].join('\r\n');
    const { data } = await gmailApi(refreshToken).users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(mime, 'utf8').toString('base64url') },
    });
    return { id: data.id ?? '' };
  },

  async listMailSince(refreshToken, afterInternalDate): Promise<IngestEmail[]> {
    const api = gmailApi(refreshToken);
    // Gmail's `after:` filter is second-granular; the strict internalDate
    // comparison below is what actually enforces "newer than the watermark".
    const afterSec = Math.floor(afterInternalDate / 1000);
    const { data } = await api.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'],
      q: afterInternalDate > 0 ? `after:${afterSec}` : 'newer_than:1d',
      maxResults: 50,
    });
    const ids = (data.messages ?? []).map((m) => m.id ?? '').filter(Boolean);
    const metas = await fetchMetadata(api, ids);
    return metas
      .map((m) => ({
        id: m.id ?? '',
        internalDate: Number(m.internalDate ?? 0),
        from: header(m.payload, 'From'),
        subject: header(m.payload, 'Subject'),
        snippet: m.snippet ?? '',
      }))
      .filter((m) => m.internalDate > afterInternalDate)
      .sort((a, b) => a.internalDate - b.internalDate);
  },
};
