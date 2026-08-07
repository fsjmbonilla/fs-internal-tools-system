import { calendar, type calendar_v3 } from '@googleapis/calendar';
import { drive, type drive_v3 } from '@googleapis/drive';
import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { Readable } from 'node:stream';
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

function driveApi(refreshToken: string): drive_v3.Drive {
  return drive({ version: 'v3', auth: oauthClient(refreshToken) as never });
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_FIELDS =
  'id, name, mimeType, webViewLink, size, modifiedTime, owners(emailAddress), ' +
  'thumbnailLink, shared, imageMediaMetadata(width, height)';

function toDriveFile(f: drive_v3.Schema$File): import('./port.js').DriveFile {
  return {
    id: f.id ?? '',
    name: f.name ?? '',
    mimeType: f.mimeType ?? '',
    isFolder: f.mimeType === FOLDER_MIME,
    webViewLink: f.webViewLink ?? null,
    sizeBytes: f.size != null ? Number(f.size) : null,
    modifiedAt: f.modifiedTime ?? null,
    owner: f.owners?.[0]?.emailAddress ?? null,
    thumbnailLink: f.thumbnailLink ?? null,
    shared: f.shared ?? false,
    imageWidth: f.imageMediaMetadata?.width ?? null,
    imageHeight: f.imageMediaMetadata?.height ?? null,
  };
}

/** Escape a value for Drive's query language (single-quoted strings). */
function driveEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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

/**
 * Gmail's per-user quota answers 429 (or 403 rateLimitExceeded) when a burst
 * outruns it. Google's guidance is exponential backoff with jitter; three
 * retries covers a burst without turning a real outage into a hang.
 */
async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [500, 1500, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as {
        status?: number;
        code?: number;
        errors?: Array<{ reason?: string }>;
      };
      const status = e.status ?? e.code;
      // 403 is also plain permission-denied — only its rate-limit flavors retry.
      const rateLimited403 =
        status === 403 &&
        (e.errors ?? []).some((x) => /ratelimit|quota/i.test(x.reason ?? ''));
      const retryable = status === 429 || rateLimited403;
      if (!retryable || attempt >= delays.length) throw err;
      const base = delays[attempt];
      await new Promise((r) => setTimeout(r, base + Math.floor(Math.random() * base)));
    }
  }
}

async function fetchMetadata(
  api: gmail_v1.Gmail,
  ids: string[],
): Promise<gmail_v1.Schema$Message[]> {
  // Sequential-ish but bounded: the list endpoints cap at 25–50 ids per call.
  const out: gmail_v1.Schema$Message[] = [];
  for (const id of ids) {
    const { data } = await withBackoff(() =>
      api.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject'],
      }),
    );
    out.push(data);
  }
  return out;
}

/**
 * The MIME for a reply (send or draft). Header values come from a hostile
 * message; a CR/LF smuggled through one would inject headers into the MIME
 * assembled here — hence the clean(). `all` Cc's every original To/Cc
 * recipient except ourselves and the new To.
 */
async function buildReplyMime(
  api: gmail_v1.Gmail,
  { messageId, body, all }: { messageId: string; body: string; all?: boolean },
): Promise<{ mime: string; threadId: string | undefined }> {
  const { data: original } = await withBackoff(() =>
    api.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'Reply-To', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
    }),
  );
  const clean = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();
  const to = clean(header(original.payload, 'Reply-To') || header(original.payload, 'From'));
  if (!to) throw new Error('original message has no sender to reply to');
  let cc = '';
  if (all) {
    const { data: profile } = await withBackoff(() => api.users.getProfile({ userId: 'me' }));
    const self = (profile.emailAddress ?? '').toLowerCase();
    const addr = (v: string) => (v.match(/<([^>]+)>/)?.[1] ?? v).trim().toLowerCase();
    cc = [
      ...clean(header(original.payload, 'To')).split(','),
      ...clean(header(original.payload, 'Cc')).split(','),
    ]
      .map((v) => v.trim())
      .filter(Boolean)
      .filter((v) => addr(v) !== self && addr(v) !== addr(to))
      .join(', ');
  }
  const subjectRaw = clean(header(original.payload, 'Subject'));
  const subject = /^re:/i.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`;
  const origMsgId = clean(header(original.payload, 'Message-ID'));
  const references = clean(
    [header(original.payload, 'References'), origMsgId].filter(Boolean).join(' '),
  );
  const mime = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeSubject(subject)}`,
    ...(origMsgId ? [`In-Reply-To: ${origMsgId}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    body,
  ].join('\r\n');
  return { mime, threadId: original.threadId ?? undefined };
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

  async listMailItemsSince(refreshToken, afterInternalDate) {
    const api = gmailApi(refreshToken);
    const afterSec = Math.floor(afterInternalDate / 1000);
    const { data } = await withBackoff(() =>
      api.users.messages.list({
        userId: 'me',
        labelIds: ['INBOX'],
        // Seeding pulls one recent page; `after:` is second-granular, so the
        // strict internalDate filter below enforces the real watermark.
        q: afterInternalDate > 0 ? `after:${afterSec}` : undefined,
        maxResults: 50,
      }),
    );
    const ids = (data.messages ?? []).map((m) => m.id ?? '').filter(Boolean);
    const metas = await fetchMetadata(api, ids);
    return metas
      .map((m) => ({ ...toListItem(m), internalDate: Number(m.internalDate ?? 0) }))
      .filter((m) => m.internalDate > afterInternalDate)
      .sort((a, b) => a.internalDate - b.internalDate);
  },

  async replyMail(refreshToken, { messageId, body, all }) {
    const api = gmailApi(refreshToken);
    const { mime, threadId } = await buildReplyMime(api, { messageId, body, all });
    const { data } = await withBackoff(() =>
      api.users.messages.send({
        userId: 'me',
        requestBody: { raw: Buffer.from(mime, 'utf8').toString('base64url'), threadId },
      }),
    );
    return { id: data.id ?? '' };
  },

  async createDraft(refreshToken, { to, subject, body, replyToMessageId }) {
    const api = gmailApi(refreshToken);
    let raw: string;
    let threadId: string | undefined;
    if (replyToMessageId) {
      const built = await buildReplyMime(api, { messageId: replyToMessageId, body });
      raw = built.mime;
      threadId = built.threadId;
    } else {
      raw = [
        ...(to ? [`To: ${to}`] : []),
        `Subject: ${encodeSubject(subject ?? '')}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 7bit',
        '',
        body,
      ].join('\r\n');
    }
    const { data } = await withBackoff(() =>
      api.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: { raw: Buffer.from(raw, 'utf8').toString('base64url'), threadId },
        },
      }),
    );
    return { id: data.id ?? '' };
  },

  async markMailRead(refreshToken, messageId) {
    await withBackoff(() =>
      gmailApi(refreshToken).users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      }),
    );
  },

  async listDriveFiles(refreshToken, opts) {
    // The modes are exclusive on purpose: a name search scoped to one folder is
    // not what Drive's own UI does either, and mixing them makes the query
    // ambiguous. sharedWithMe wins — "what landed in my Shared with me" has no
    // parent folder of ours to scope to.
    const q = opts.sharedWithMe
      ? 'sharedWithMe = true and trashed = false'
      : opts.q
        ? `name contains '${driveEscape(opts.q)}' and trashed = false`
        : `'${driveEscape(opts.folderId ?? 'root')}' in parents and trashed = false`;
    const { data } = await driveApi(refreshToken).files.list({
      q,
      pageToken: opts.pageToken,
      pageSize: 50,
      // Shared-with-me is a feed (newest grant first); browsing stays folders-then-name.
      orderBy: opts.sharedWithMe ? 'sharedWithMeTime desc' : 'folder,name',
      fields: `nextPageToken, files(${DRIVE_FIELDS})`,
    });
    return {
      files: (data.files ?? []).map(toDriveFile),
      nextPageToken: data.nextPageToken ?? null,
    };
  },

  async getDriveFile(refreshToken, fileId) {
    try {
      const { data } = await driveApi(refreshToken).files.get({
        fileId,
        fields: DRIVE_FIELDS,
      });
      return toDriveFile(data);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  },

  async uploadDriveFile(refreshToken, { folderId, name, mimeType, data }) {
    const { data: created } = await driveApi(refreshToken).files.create({
      requestBody: { name, parents: [folderId] },
      media: { mimeType, body: Readable.from(data) },
      fields: DRIVE_FIELDS,
    });
    return toDriveFile(created);
  },

  async ensureDriveFolder(refreshToken, name) {
    const api = driveApi(refreshToken);
    const { data } = await api.files.list({
      q: `name = '${driveEscape(name)}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`,
      pageSize: 1,
      fields: 'files(id)',
    });
    const existing = data.files?.[0]?.id;
    if (existing) return { id: existing };
    const { data: created } = await api.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: ['root'] },
      fields: 'id',
    });
    return { id: created.id ?? '' };
  },

  async updateDriveFile(refreshToken, fileId, { name, mimeType, data }) {
    await driveApi(refreshToken).files.update({
      fileId,
      requestBody: { name },
      media: { mimeType, body: Readable.from(data) },
    });
  },

  async moveDriveFile(refreshToken, fileId, toFolderId) {
    const api = driveApi(refreshToken);
    const { data } = await api.files.get({ fileId, fields: 'parents' });
    await api.files.update({
      fileId,
      addParents: toFolderId,
      removeParents: (data.parents ?? []).join(','),
    });
  },

  async shareDriveFile(refreshToken, fileId, { email, role }) {
    await driveApi(refreshToken).permissions.create({
      fileId,
      requestBody: { type: 'user', role, emailAddress: email },
      // In-app share to a colleague; the app is the notification surface.
      sendNotificationEmail: false,
    });
  },

  async exportDriveFile(refreshToken, fileId) {
    const api = driveApi(refreshToken);
    let meta: drive_v3.Schema$File;
    try {
      ({ data: meta } = await api.files.get({ fileId, fields: 'name, mimeType' }));
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
    const name = meta.name ?? 'file';
    const native = GOOGLE_EXPORTS[meta.mimeType ?? ''];
    if (native) {
      const { data } = await api.files.export(
        { fileId, mimeType: native.mimeType },
        { responseType: 'arraybuffer' },
      );
      return {
        name: `${name}.${native.ext}`,
        mimeType: native.mimeType,
        data: Buffer.from(data as ArrayBuffer),
      };
    }
    if ((meta.mimeType ?? '').startsWith('application/vnd.google-apps.')) return null;
    const { data } = await api.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' },
    );
    return {
      name,
      mimeType: meta.mimeType ?? 'application/octet-stream',
      data: Buffer.from(data as ArrayBuffer),
    };
  },
};

/** How each Google-native type leaves Drive for in-app rendering. */
const GOOGLE_EXPORTS: Record<string, { mimeType: string; ext: string }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: 'docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/pdf',
    ext: 'pdf',
  },
};
