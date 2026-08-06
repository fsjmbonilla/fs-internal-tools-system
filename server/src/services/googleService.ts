import { and, eq, isNull } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { googleAccounts } from '../db/schema/index.js';
import { logger } from '../logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { getBotUserId } from './botService.js';
import { findOrCreateDm } from './channelService.js';
import { decryptToken, encryptToken } from './googleCrypto.js';
import { getGooglePort } from './google/port.js';
import { sendMessage } from './messageService.js';

/**
 * Google connection lifecycle: consent URL, callback exchange, encrypted
 * storage, disconnect, and the `withGoogle` wrapper every Google call runs
 * inside.
 *
 * Two kinds of connection exist. `user` is personal — one per person, reaching
 * their own calendar and mail, usable only by them (and, deliberately, by
 * agents *they* empower: a routine they own, a token they created). `support_
 * mailbox` is the org-level connector the poller reads; admins manage it and
 * it never gains calendar or send scopes, because a shared mailbox that the
 * whole platform can send from is a phishing kit.
 */

export type GoogleKind = 'user' | 'support_mailbox';

const USER_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'openid',
  'email',
];

const MAILBOX_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email'];

export function isGoogleConfigured(): boolean {
  return Boolean(
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_TOKEN_ENC_KEY,
  );
}

function requireConfigured(): void {
  if (!isGoogleConfigured()) {
    throw new AppError(503, 'google_not_configured', 'Google is not configured on this server');
  }
}

// ─── OAuth state ─────────────────────────────────────────────────────────────
// The callback arrives from Google's redirect with no Authorization header, so
// the state parameter IS the authentication: a short-lived JWT naming who
// started the flow and which kind of connection they were connecting. Signing
// it is also the CSRF defence — a forged callback cannot mint one.

const STATE_AUDIENCE = 'google-oauth-state';
const secret = new TextEncoder().encode(config.JWT_SECRET);

async function signState(userId: number, kind: GoogleKind): Promise<string> {
  return new SignJWT({ kind })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(STATE_AUDIENCE)
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secret);
}

async function verifyState(state: string): Promise<{ userId: number; kind: GoogleKind }> {
  try {
    const { payload } = await jwtVerify(state, secret, { audience: STATE_AUDIENCE });
    const kind = payload.kind as GoogleKind;
    if (kind !== 'user' && kind !== 'support_mailbox') throw new Error('bad kind');
    return { userId: Number(payload.sub), kind };
  } catch {
    throw new AppError(400, 'invalid_state', 'The sign-in link is invalid or has expired');
  }
}

export async function authUrlFor(userId: number, kind: GoogleKind): Promise<string> {
  requireConfigured();
  const scopes = kind === 'user' ? USER_SCOPES : MAILBOX_SCOPES;
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID!,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    // `offline` + `consent` is what guarantees a refresh token; without the
    // consent prompt a re-connect silently returns none and the row is useless.
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes.join(' '),
    state: await signState(userId, kind),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ─── Connections ─────────────────────────────────────────────────────────────

function kindFilter(kind: GoogleKind, userId?: number) {
  return kind === 'user'
    ? and(eq(googleAccounts.kind, 'user'), eq(googleAccounts.userId, userId!))
    : and(eq(googleAccounts.kind, 'support_mailbox'), isNull(googleAccounts.userId));
}

export async function getConnection(kind: GoogleKind, userId?: number) {
  const [row] = await db.select().from(googleAccounts).where(kindFilter(kind, userId));
  return row ?? null;
}

/**
 * Finish the OAuth dance: verify state, exchange the code, store the encrypted
 * refresh token. Re-connecting updates the existing row in place — deleting it
 * would cascade away `gmail_ingest_state` and silently unbind the mailbox.
 */
export async function handleCallback(
  code: string,
  state: string,
): Promise<{ kind: GoogleKind; email: string }> {
  requireConfigured();
  const { userId, kind } = await verifyState(state);
  const { refreshToken, email } = await getGooglePort().exchangeCode(code);
  if (!refreshToken) {
    throw new AppError(
      400,
      'google_no_refresh_token',
      'Google did not issue a refresh token — try connecting again',
    );
  }

  const values = {
    googleEmail: email ?? '',
    refreshTokenEnc: encryptToken(refreshToken),
    scopes: kind === 'user' ? USER_SCOPES : MAILBOX_SCOPES,
    status: 'active' as const,
    connectedBy: userId,
  };
  const existing = await getConnection(kind, userId);
  if (existing) {
    await db.update(googleAccounts).set(values).where(eq(googleAccounts.id, existing.id));
  } else {
    await db.insert(googleAccounts).values({
      ...values,
      userId: kind === 'user' ? userId : null,
      kind,
    });
  }
  return { kind, email: email ?? '' };
}

/** Revoke at Google (best-effort) and delete the row. */
export async function disconnect(kind: GoogleKind, userId?: number): Promise<boolean> {
  const row = await getConnection(kind, userId);
  if (!row) return false;
  try {
    await getGooglePort().revoke(decryptToken(row.refreshTokenEnc));
  } catch (err) {
    // A grant already revoked on Google's side must not strand the row here.
    logger.warn({ err, accountId: row.id }, 'google revoke failed; deleting connection anyway');
  }
  await db.delete(googleAccounts).where(eq(googleAccounts.id, row.id));
  return true;
}

export interface ConnectionStatus {
  connected: boolean;
  email: string | null;
  broken: boolean;
}

function statusOf(row: { googleEmail: string; status: string } | null): ConnectionStatus {
  return row
    ? { connected: true, email: row.googleEmail, broken: row.status === 'broken' }
    : { connected: false, email: null, broken: false };
}

export async function getStatus(userId: number, isAdmin: boolean) {
  const user = statusOf(await getConnection('user', userId));
  return {
    configured: isGoogleConfigured(),
    user,
    // The mailbox connector is admin business; everyone else has no reason to
    // know whether one exists.
    ...(isAdmin ? { supportMailbox: statusOf(await getConnection('support_mailbox')) } : {}),
  };
}

// ─── Running calls against a connection ──────────────────────────────────────

type GoogleAccountRow = NonNullable<Awaited<ReturnType<typeof getConnection>>>;

/**
 * A connection the caller can actually use, or the 409 the UI knows how to
 * render. 409 rather than 404 on purpose: the *feature* exists — what is
 * missing is a connection, and the client turns each code into its fix.
 */
export async function requireConnection(
  kind: GoogleKind,
  userId?: number,
): Promise<GoogleAccountRow> {
  requireConfigured();
  const row = await getConnection(kind, userId);
  if (!row) {
    throw new AppError(409, 'google_not_connected', 'Connect Google in Settings first');
  }
  if (row.status === 'broken') {
    throw new AppError(
      409,
      'google_connection_broken',
      'The Google connection needs to be reconnected in Settings',
    );
  }
  return row;
}

function isInvalidGrant(err: unknown): boolean {
  const e = err as { message?: string; response?: { data?: { error?: string } } };
  return e?.response?.data?.error === 'invalid_grant' || /invalid_grant/i.test(e?.message ?? '');
}

async function markBroken(account: GoogleAccountRow): Promise<void> {
  await db
    .update(googleAccounts)
    .set({ status: 'broken' })
    .where(eq(googleAccounts.id, account.id));
  // Tell the person who can fix it — the owner for a personal connection, the
  // admin who connected the mailbox for the org one.
  try {
    const botUserId = await getBotUserId();
    const notifyUserId = account.userId ?? account.connectedBy;
    if (botUserId !== null && botUserId !== notifyUserId) {
      const dm = await findOrCreateDm(botUserId, notifyUserId);
      const which = account.kind === 'user' ? 'Your Google connection' : 'The support mailbox';
      await sendMessage(
        dm.id,
        botUserId,
        `${which} (${account.googleEmail}) stopped working — Google reports the grant was revoked or expired. Reconnect it in Settings to resume.`,
      );
    }
  } catch (err) {
    logger.warn({ err, accountId: account.id }, 'could not DM about broken google connection');
  }
}

/**
 * Run one Google call with the account's decrypted refresh token. On
 * `invalid_grant` the row is marked broken and the owner DM'd — once; broken
 * rows are refused by `requireConnection` and skipped by the poller, so a dead
 * grant never becomes a retry loop.
 */
export async function withGoogle<T>(
  account: GoogleAccountRow,
  fn: (refreshToken: string) => Promise<T>,
): Promise<T> {
  let refreshToken: string;
  try {
    refreshToken = decryptToken(account.refreshTokenEnc);
  } catch {
    // Wrong or rotated GOOGLE_TOKEN_ENC_KEY — same remedy as a dead grant.
    await markBroken(account);
    throw new AppError(
      409,
      'google_connection_broken',
      'The Google connection needs to be reconnected in Settings',
    );
  }
  try {
    return await fn(refreshToken);
  } catch (err) {
    if (isInvalidGrant(err)) {
      await markBroken(account);
      throw new AppError(
        409,
        'google_connection_broken',
        'The Google connection needs to be reconnected in Settings',
      );
    }
    throw err;
  }
}
