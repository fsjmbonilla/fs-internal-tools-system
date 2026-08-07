import { and, count, eq, gte, isNull, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { aiUsage } from '../db/schema/index.js';
import { logger } from '../logger.js';

/**
 * The AI spend ceiling.
 *
 * Triage is the only per-message cost in the platform and nothing bounded it:
 * `express-rate-limit` covers auth and uploads, not message send, so one message
 * every few seconds sustained hundreds of paid calls an hour on a single channel.
 * The debounce coalesces a burst *before* a call starts; it does not throttle a
 * steady stream, which is the shape a spend runaway actually takes.
 *
 * Two limits, both read from the `ai_usage` ledger:
 *   - a per-channel minimum interval, so one busy channel cannot dominate spend;
 *   - a platform-wide daily cap, as the backstop when many channels are busy.
 *
 * Both fail *open* on a database error. An unreachable database already breaks
 * triage a moment later when it reads the transcript, and refusing to answer a
 * support channel because a COUNT failed would be the wrong trade.
 *
 * Both windows are evaluated by MySQL (NOW(), CURDATE()) rather than by comparing
 * `created_at` to a JS Date. Drizzle maps a MySQL TIMESTAMP back through UTC, so
 * a row written by the column default and read into JS lands off by the host's
 * UTC offset — zero on a UTC server, and eight hours on a Manila workstation,
 * which is the kind of bug that passes CI and fails locally. Keeping both sides
 * of every comparison inside the database sidesteps it entirely.
 */

export interface AiUsageRecord {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export type BudgetVerdict = { ok: true } | { ok: false; reason: 'interval' | 'daily_cap' };

/** Midnight today, as the database reckons it — the daily cap's window. */
const startOfDay = sql`CURDATE()`;

/** `created_at` is second-precision, so the interval is expressed in whole seconds. */
function intervalAgo(): ReturnType<typeof sql> {
  const seconds = Math.ceil(config.AI_MIN_INTERVAL_MS / 1000);
  return sql`NOW() - INTERVAL ${seconds} SECOND`;
}

/**
 * `channelId` is null for calls made outside any conversation (the script
 * assistant). Those share one channel-less interval bucket and count toward the
 * platform-wide daily cap like everything else.
 */
export async function checkAiBudget(channelId: number | null): Promise<BudgetVerdict> {
  try {
    if (config.AI_MIN_INTERVAL_MS > 0) {
      const sameChannel =
        channelId === null ? isNull(aiUsage.channelId) : eq(aiUsage.channelId, channelId);
      const [recent] = await db
        .select({ n: count() })
        .from(aiUsage)
        .where(and(sameChannel, gte(aiUsage.createdAt, intervalAgo())));
      if ((recent?.n ?? 0) > 0) return { ok: false, reason: 'interval' };
    }

    if (config.AI_DAILY_CALL_CAP > 0) {
      const [today] = await db.select({ n: count() }).from(aiUsage).where(gte(aiUsage.createdAt, startOfDay));
      if ((today?.n ?? 0) >= config.AI_DAILY_CALL_CAP) {
        return { ok: false, reason: 'daily_cap' };
      }
    }

    return { ok: true };
  } catch (err) {
    logger.error({ err, channelId }, 'aiBudget: check failed, allowing the call');
    return { ok: true };
  }
}

/**
 * Record an attempt. Called for every triage that was actually dispatched,
 * including one that failed or returned nothing — a failing provider that were
 * not recorded would be retried at full speed, which is the hot loop this is
 * here to prevent.
 */
export async function recordAiUsage(channelId: number | null, usage: AiUsageRecord): Promise<void> {
  try {
    await db.insert(aiUsage).values({
      channelId,
      provider: usage.provider,
      model: usage.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });
    // The cost trail: one line per paid call, greppable by channel.
    logger.info(
      {
        channelId,
        provider: usage.provider,
        model: usage.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      },
      'ai usage',
    );
  } catch (err) {
    logger.error({ err, channelId }, 'aiBudget: failed to record usage');
  }
}

/** Triages counted against today's cap — for diagnostics and tests. */
export async function todaysAiCallCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(aiUsage).where(gte(aiUsage.createdAt, startOfDay));
  return row?.n ?? 0;
}

/** Triages for one channel today — used by the tests and worth having for support. */
export async function channelAiCallCount(channelId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(aiUsage)
    .where(and(eq(aiUsage.channelId, channelId), gte(aiUsage.createdAt, startOfDay)));
  return row?.n ?? 0;
}
