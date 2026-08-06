import sanitizeHtml from 'sanitize-html';
import { AppError } from '../middleware/errorHandler.js';
import { getGooglePort, type GmailListResult, type GmailMessage } from './google/port.js';
import { requireConnection, withGoogle } from './googleService.js';

/**
 * Gmail, always through the caller's own connection. Same thin shape as
 * `calendarService`, with one added duty: an email body is hostile input from
 * an arbitrary sender, so the HTML part never leaves this module unsanitized —
 * not for the SPA, not for an agent tool.
 */

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'div', 'span', 'a', 'b', 'i', 'strong', 'em', 'u', 's',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
  ],
  // No img: a tracking pixel fires the moment the message renders, and a
  // cid:/data: source is a smuggling vector. Text is what support needs.
  allowedAttributes: { a: ['href', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  disallowedTagsMode: 'discard',
  // A link in someone's email must not navigate the app away in place, and
  // must not hand the opened page a window.opener or a referrer.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', {
      target: '_blank',
      rel: 'noopener noreferrer nofollow',
    }),
  },
};

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTS);
}

export async function listMail(
  userId: number,
  opts: { q?: string; labelId?: string; pageToken?: string },
): Promise<GmailListResult> {
  const account = await requireConnection('user', userId);
  return withGoogle(account, (token) => getGooglePort().listMail(token, opts));
}

export async function getMail(userId: number, id: string): Promise<GmailMessage | null> {
  const account = await requireConnection('user', userId);
  const message = await withGoogle(account, (token) => getGooglePort().getMail(token, id));
  if (!message) return null;
  return {
    ...message,
    bodyHtml: message.bodyHtml === null ? null : sanitizeEmailHtml(message.bodyHtml),
  };
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
