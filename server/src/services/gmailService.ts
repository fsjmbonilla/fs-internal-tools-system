import { and, desc, eq, sql } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';
import { db } from '../db/index.js';
import { gmailCache, gmailSyncState } from '../db/schema/index.js';
import { AppError } from '../middleware/errorHandler.js';
import { getGooglePort, type GmailListResult, type GmailMessage } from './google/port.js';
import { requireConnection, withGoogle } from './googleService.js';
import { completeText } from './aiService.js';
import type { TriageUsage } from './ai/triage.js';

type Account = Awaited<ReturnType<typeof requireConnection>>;

/**
 * Gmail, always through the caller's own connection. Same thin shape as
 * `calendarService`, with one added duty: an email body is hostile input from
 * an arbitrary sender, so the HTML part never leaves this module unsanitized —
 * not for the SPA, not for an agent tool.
 */

/**
 * Full-fidelity rendering — a deliberate owner decision (2026-08-07): emails
 * keep their layout, inline styles, colors and images, like a mail client
 * with "always display images" on. What stays banned is anything that can
 * EXECUTE or navigate the app: scripts, event handlers, iframes, forms,
 * javascript:/data: URLs. The client renders this inside a sandboxed iframe
 * (no allow-scripts), which is the second lock on the same door — and why
 * allowing <style> here is acceptable (allowVulnerableTags acknowledges it).
 */
const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img', 'style', 'center', 'font', 'u', 'big', 'small',
  ]),
  allowVulnerableTags: true,
  allowedAttributes: {
    '*': [
      'style', 'align', 'valign', 'width', 'height', 'bgcolor', 'background',
      'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'dir', 'lang',
    ],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'loading', 'referrerpolicy'],
    font: ['color', 'face', 'size'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // https-only images: kills cid:/data: smuggling; the open-tracking pixel
  // that remains is the accepted cost of full rendering.
  allowedSchemesByTag: { img: ['https'] },
  disallowedTagsMode: 'discard',
  // A link in someone's email must not navigate the app away in place, and
  // must not hand the opened page a window.opener or a referrer.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', {
      target: '_blank',
      rel: 'noopener noreferrer nofollow',
    }),
    img: sanitizeHtml.simpleTransform('img', {
      loading: 'lazy',
      referrerpolicy: 'no-referrer',
    }),
  },
};

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTS);
}

/**
 * One remote sync per account per window; every other refresh inside it is a
 * pure DB read costing no Gmail quota. The freshness check runs in the
 * database clock (invariant 10 — never compare a TIMESTAMP in JS).
 */
const SYNC_WINDOW_SEC = 60;
const CACHE_PAGE_SIZE = 100;

async function syncInbox(account: Account): Promise<void> {
  const [state] = await db
    .select({
      watermark: gmailSyncState.watermark,
      fresh: sql<number>`last_sync_at > NOW() - INTERVAL ${sql.raw(String(SYNC_WINDOW_SEC))} SECOND`,
    })
    .from(gmailSyncState)
    .where(eq(gmailSyncState.googleAccountId, account.id));
  if (state?.fresh) return;

  const watermark = state?.watermark ?? 0;
  const items = await withGoogle(account, (token) =>
    getGooglePort().listMailItemsSince(token, watermark),
  );
  if (items.length > 0) {
    await db
      .insert(gmailCache)
      .values(
        items.map((m) => ({
          googleAccountId: account.id,
          messageId: m.id,
          threadId: m.threadId,
          fromAddr: m.from,
          subject: m.subject,
          snippet: m.snippet,
          internalDate: m.internalDate,
          unread: m.unread,
        })),
      )
      // Same message twice (watermark replay) is "already cached", not an error.
      .onDuplicateKeyUpdate({ set: { messageId: sql`message_id` } });
  }
  const newWatermark = items.reduce((max, m) => Math.max(max, m.internalDate), watermark);
  await db
    .insert(gmailSyncState)
    .values({ googleAccountId: account.id, watermark: newWatermark })
    .onDuplicateKeyUpdate({ set: { watermark: newWatermark, lastSyncAt: sql`NOW()` } });
}

function rowToListItem(row: typeof gmailCache.$inferSelect) {
  return {
    id: row.messageId,
    threadId: row.threadId,
    from: row.fromAddr,
    subject: row.subject,
    snippet: row.snippet,
    date: new Date(row.internalDate).toISOString(),
    unread: row.unread,
  };
}

export async function listMail(
  userId: number,
  opts: { q?: string; labelId?: string; pageToken?: string },
): Promise<GmailListResult> {
  const account = await requireConnection('user', userId);
  // Search and label browsing stay live — the cache is the default inbox only.
  if (opts.q || opts.labelId || opts.pageToken) {
    return withGoogle(account, (token) => getGooglePort().listMail(token, opts));
  }
  await syncInbox(account);
  const rows = await db
    .select()
    .from(gmailCache)
    .where(eq(gmailCache.googleAccountId, account.id))
    .orderBy(desc(gmailCache.internalDate))
    .limit(CACHE_PAGE_SIZE);
  return { messages: rows.map(rowToListItem), nextPageToken: null };
}

/**
 * Opening a message marks it read: always in our cache (what the list
 * renders), and best-effort in Gmail itself — a grant that predates
 * gmail.modify answers the modify with a scope 403, which is swallowed
 * rather than surfaced (the message still opens; reconnecting fixes sync).
 */
async function markRead(account: Account, id: string, wasUnread: boolean): Promise<void> {
  if (!wasUnread) return;
  await db
    .update(gmailCache)
    .set({ unread: false })
    .where(and(eq(gmailCache.googleAccountId, account.id), eq(gmailCache.messageId, id)));
  try {
    await withGoogle(account, (token) => getGooglePort().markMailRead(token, id));
  } catch {
    // Scope 403 (old grant) or a transient failure — the app-side state is
    // already correct, and the next full reconnect heals Gmail-side sync.
  }
}

export async function getMail(userId: number, id: string): Promise<GmailMessage | null> {
  const account = await requireConnection('user', userId);
  const [cached] = await db
    .select()
    .from(gmailCache)
    .where(and(eq(gmailCache.googleAccountId, account.id), eq(gmailCache.messageId, id)));
  // A Gmail message is immutable — once the body is here, Google is never asked again.
  if (cached?.bodyFetchedAt) {
    await markRead(account, id, cached.unread);
    return {
      ...rowToListItem(cached),
      to: cached.toAddr,
      bodyText: cached.bodyText,
      bodyHtml: cached.bodyHtml,
      unread: false,
    };
  }
  const message = await withGoogle(account, (token) => getGooglePort().getMail(token, id));
  if (!message) return null;
  const sanitized = {
    ...message,
    bodyHtml: message.bodyHtml === null ? null : sanitizeEmailHtml(message.bodyHtml),
  };
  await db
    .insert(gmailCache)
    .values({
      googleAccountId: account.id,
      messageId: sanitized.id,
      threadId: sanitized.threadId,
      fromAddr: sanitized.from,
      toAddr: sanitized.to,
      subject: sanitized.subject,
      snippet: sanitized.snippet,
      internalDate: Date.parse(sanitized.date) || 0,
      unread: sanitized.unread,
      bodyText: sanitized.bodyText,
      bodyHtml: sanitized.bodyHtml,
      bodyFetchedAt: sql`NOW()`,
    })
    .onDuplicateKeyUpdate({
      set: {
        toAddr: sanitized.to,
        bodyText: sanitized.bodyText,
        bodyHtml: sanitized.bodyHtml,
        bodyFetchedAt: sql`NOW()`,
      },
    });
  await markRead(account, id, sanitized.unread);
  return { ...sanitized, unread: false };
}

/** Reply inside the thread; To/Subject/References derive from the original. */
export async function replyMail(
  userId: number,
  input: { messageId: string; body: string; all?: boolean },
): Promise<{ id: string }> {
  const account = await requireConnection('user', userId);
  return withGoogle(account, (token) => getGooglePort().replyMail(token, input));
}

/** The message as plain text — the cached text part, or the HTML stripped to text. */
function messageText(message: GmailMessage): string {
  return (
    message.bodyText ??
    (message.bodyHtml
      ? message.bodyHtml.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ').trim()
      : message.snippet)
  );
}

/**
 * Forward: a fresh send whose body carries the original as quoted text. The
 * quoted material is the cached plain-text part (or a tag-stripped fallback) —
 * forwarding re-sends CONTENT, never the original's raw HTML.
 */
export async function forwardMail(
  userId: number,
  input: { messageId: string; to: string; note?: string },
): Promise<{ id: string }> {
  const original = await getMail(userId, input.messageId);
  if (!original) throw new AppError(404, 'not_found', 'Not found');
  const text = messageText(original);
  const subjectLine = original.subject.replace(/[\r\n]+/g, ' ');
  const body = [
    ...(input.note ? [input.note, ''] : []),
    '---------- Forwarded message ----------',
    `From: ${original.from.replace(/[\r\n]+/g, ' ')}`,
    `Date: ${new Date(original.date).toString()}`,
    `Subject: ${subjectLine}`,
    `To: ${original.to.replace(/[\r\n]+/g, ' ')}`,
    '',
    text,
  ].join('\n');
  return sendMail(userId, {
    to: input.to,
    subject: /^fwd:/i.test(subjectLine) ? subjectLine : `Fwd: ${subjectLine}`,
    body,
  });
}

/** Save a Gmail draft — a reply draft when replyToMessageId is set. */
export async function saveDraft(
  userId: number,
  input: { to?: string; subject?: string; body: string; replyToMessageId?: string },
): Promise<{ id: string }> {
  if (input.to && !SANE_EMAIL.test(input.to)) {
    throw new AppError(400, 'validation_error', 'to must be a single email address');
  }
  if (input.subject && /[\r\n]/.test(input.subject)) {
    throw new AppError(400, 'validation_error', 'subject must be a single line');
  }
  const account = await requireConnection('user', userId);
  return withGoogle(account, (token) => getGooglePort().createDraft(token, input));
}

/**
 * An AI-written reply suggestion, built from the (cached) message content.
 * A paid call — the ROUTE gates it through aiBudgetService before this runs.
 */
export async function draftReply(
  userId: number,
  input: { messageId: string; instruction?: string },
  onUsage: (usage: TriageUsage) => void,
): Promise<string> {
  const original = await getMail(userId, input.messageId);
  if (!original) throw new AppError(404, 'not_found', 'Not found');
  const text = messageText(original).slice(0, 6000);
  return completeText({
    system:
      'You draft replies to emails on behalf of the user. Write a concise, professional ' +
      'reply in the same language as the original. Output ONLY the reply body text — ' +
      'no subject line, no quoted original, no placeholders.',
    prompt: [
      `From: ${original.from}`,
      `Subject: ${original.subject}`,
      '',
      text,
      '',
      ...(input.instruction ? [`Guidance from the user: ${input.instruction}`] : []),
      'Write the reply.',
    ].join('\n'),
    maxTokens: 700,
    onUsage,
  });
}

/**
 * Loose sanity check, tight injection check. The MIME message is assembled by
 * string interpolation, so a CR/LF smuggled into `to` would inject arbitrary
 * headers (Bcc: is the classic). The REST route's zod email validation already
 * forbids this, but the agent tool is another caller of this function and the
 * model's input is exactly the kind that needs the belt-and-braces here.
 */
const SANE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendMail(
  userId: number,
  input: { to: string; subject: string; body: string },
): Promise<{ id: string }> {
  if (!SANE_EMAIL.test(input.to)) {
    throw new AppError(400, 'validation_error', 'to must be a single email address');
  }
  if (/[\r\n]/.test(input.subject)) {
    throw new AppError(400, 'validation_error', 'subject must be a single line');
  }
  const account = await requireConnection('user', userId);
  return withGoogle(account, (token) => getGooglePort().sendMail(token, input));
}
