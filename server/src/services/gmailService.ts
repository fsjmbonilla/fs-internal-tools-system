import sanitizeHtml from 'sanitize-html';
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
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  disallowedTagsMode: 'discard',
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

export async function sendMail(
  userId: number,
  input: { to: string; subject: string; body: string },
): Promise<{ id: string }> {
  const account = await requireConnection('user', userId);
  return withGoogle(account, (token) => getGooglePort().sendMail(token, input));
}
