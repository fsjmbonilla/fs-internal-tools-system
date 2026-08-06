import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiTokens, users } from '../db/schema/index.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Service tokens: how an AI agent or automation authenticates as itself.
 *
 * The token is stored only as a sha256 hash, exactly as refresh_tokens are — a
 * database leak must not yield usable credentials. The plaintext is returned once,
 * at creation, and cannot be recovered afterwards.
 */

const PREFIX = 'fsk_';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * The scope vocabulary lives in `shared/scopes.ts` because the SPA renders
 * pickers from the same list. Re-exported here so every existing importer — and
 * the mental model "scopes belong to tokens" — keeps working.
 */
// Imported *and* re-exported: `export … from` creates no local binding, so this
// module could not use `Scope` or `isScope` itself — which it does, below.
import { isScope, SCOPES, type Scope } from '../shared/scopes.js';

export { isScope, SCOPES, type Scope };

export interface TokenContext {
  tokenId: number;
  /** The bot user this token acts as — every write is attributed to it. */
  userId: number;
  role: 'admin' | 'member';
  scopes: Scope[];
}

/** Looks like one of our tokens? Cheap check before hashing or hitting the DB. */
export function looksLikeServiceToken(value: string): boolean {
  return value.startsWith(PREFIX);
}

export async function createApiToken(input: {
  name: string;
  scopes: Scope[];
  actsAsUserId: number;
  createdBy: number;
  expiresAt?: Date | null;
}): Promise<{ id: number; token: string }> {
  // The identity a token acts as must be a bot. Validated rather than trusted:
  // a token acting as a person would attribute AI writes to that person and put
  // their memberships behind the agent.
  const [actsAs] = await db
    .select({ id: users.id, isBot: users.isBot, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, input.actsAsUserId));
  if (!actsAs || !actsAs.isActive) {
    throw new AppError(404, 'not_found', 'Not found');
  }
  if (!actsAs.isBot) {
    throw new AppError(
      400,
      'not_a_bot',
      'A service token must act as a bot user, so its writes are attributable',
    );
  }

  const token = `${PREFIX}${randomBytes(32).toString('hex')}`;
  const [{ id }] = await db
    .insert(apiTokens)
    .values({
      name: input.name,
      tokenHash: sha256(token),
      scopes: input.scopes,
      actsAsUserId: input.actsAsUserId,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    })
    .$returningId();

  // Returned once. There is no path that can show it again.
  return { id, token };
}

/**
 * Last-used tracking, debounced.
 *
 * A write on every API call would put a needless UPDATE in the hot path, and
 * minute-level resolution is all an operator needs to answer "is this token still
 * in use?".
 */
const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<number, number>();

/**
 * Test-only. The debounce is keyed by token id, and truncating the table between
 * tests hands the next token the same id — so without this, the second suite to
 * mint a token sees its touch suppressed by the first suite's timestamp.
 */
export function resetTokenTouchState(): void {
  lastTouched.clear();
}

async function touchLastUsed(tokenId: number): Promise<void> {
  const now = Date.now();
  const previous = lastTouched.get(tokenId) ?? 0;
  if (now - previous < TOUCH_INTERVAL_MS) return;
  lastTouched.set(tokenId, now);
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, tokenId));
}

/** Resolve a plaintext token, or null if it cannot be used right now. */
export async function verifyApiToken(token: string): Promise<TokenContext | null> {
  const [row] = await db
    .select({
      id: apiTokens.id,
      scopes: apiTokens.scopes,
      actsAsUserId: apiTokens.actsAsUserId,
      expiresAt: apiTokens.expiresAt,
      revokedAt: apiTokens.revokedAt,
      role: users.role,
      isActive: users.isActive,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.actsAsUserId))
    .where(eq(apiTokens.tokenHash, sha256(token)));

  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;
  // Deactivating the bot user disables every token acting as it — one switch to
  // stop an agent, without hunting down its tokens.
  if (!row.isActive) return null;

  await touchLastUsed(row.id);

  return {
    tokenId: row.id,
    userId: row.actsAsUserId,
    role: row.role,
    scopes: (row.scopes ?? []).filter(isScope),
  };
}

export async function listApiTokens() {
  return db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      scopes: apiTokens.scopes,
      actsAsUserId: apiTokens.actsAsUserId,
      createdBy: apiTokens.createdBy,
      lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt,
      revokedAt: apiTokens.revokedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .orderBy(apiTokens.createdAt);
}

/** Revoke, not delete: the row is the audit trail of what the token could do. */
export async function revokeApiToken(id: number): Promise<boolean> {
  const [row] = await db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)));
  if (!row) return false;
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, id));
  return true;
}
