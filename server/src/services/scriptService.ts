import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { scriptRuns, scripts } from '../db/schema/index.js';
import { logger } from '../logger.js';
import { createApiToken, revokeApiToken, type Scope } from './apiTokenService.js';
import { getBotUserId } from './botService.js';

export type ScriptRow = typeof scripts.$inferSelect;
export type ScriptRunRow = typeof scriptRuns.$inferSelect;

/**
 * How long a minted run token lives.
 *
 * Comfortably longer than the run timeout so a slow script is not cut off by its
 * own credential, and short enough that a leaked token from a crashed run is
 * worthless within minutes. It is revoked on completion regardless; this is the
 * backstop for the path where completion never happens.
 */
const RUN_TOKEN_TTL_MS = 15 * 60 * 1000;

export async function listScripts(): Promise<ScriptRow[]> {
  return db.select().from(scripts).orderBy(scripts.name);
}

export async function getScript(id: number): Promise<ScriptRow | null> {
  const [row] = await db.select().from(scripts).where(eq(scripts.id, id));
  return row ?? null;
}

export async function createScript(input: {
  name: string;
  description?: string;
  source: string;
  scopes: Scope[];
  userId: number;
}): Promise<ScriptRow> {
  const [{ id }] = await db
    .insert(scripts)
    .values({
      name: input.name,
      description: input.description,
      source: input.source,
      scopes: input.scopes,
      createdBy: input.userId,
    })
    .$returningId();
  const row = await getScript(id);
  if (!row) throw new Error('script insert failed');
  return row;
}

export async function updateScript(
  id: number,
  userId: number,
  patch: { name?: string; description?: string; source?: string; scopes?: Scope[] },
): Promise<ScriptRow | null> {
  if (!(await getScript(id))) return null;
  await db.update(scripts).set({ ...patch, updatedBy: userId }).where(eq(scripts.id, id));
  return getScript(id);
}

export async function deleteScript(id: number): Promise<void> {
  await db.delete(scripts).where(eq(scripts.id, id));
}

export async function listRuns(scriptId: number, limit = 50): Promise<ScriptRunRow[]> {
  return db
    .select()
    .from(scriptRuns)
    .where(eq(scriptRuns.scriptId, scriptId))
    .orderBy(desc(scriptRuns.id))
    .limit(limit);
}

export async function getRun(id: number): Promise<ScriptRunRow | null> {
  const [row] = await db.select().from(scriptRuns).where(eq(scriptRuns.id, id));
  return row ?? null;
}

/** Queue a run. The runner picks it up; nothing executes in this process. */
export async function queueRun(scriptId: number, userId: number): Promise<ScriptRunRow> {
  const [{ id }] = await db
    .insert(scriptRuns)
    .values({ scriptId, triggeredBy: userId, status: 'queued' })
    .$returningId();
  const run = await getRun(id);
  if (!run) throw new Error('run insert failed');
  return run;
}

/**
 * Claim the oldest queued run, atomically.
 *
 * The UPDATE…WHERE status='queued' is the lock: two runners racing for the same
 * row means exactly one of them changes it, and `affectedRows` says which. A
 * SELECT-then-UPDATE would hand the same script to both, which for a script that
 * files tickets means filing everything twice.
 */
export async function claimNextRun(): Promise<ScriptRunRow | null> {
  const [candidate] = await db
    .select({ id: scriptRuns.id })
    .from(scriptRuns)
    .where(eq(scriptRuns.status, 'queued'))
    .orderBy(scriptRuns.id)
    .limit(1);
  if (!candidate) return null;

  const result = await db
    .update(scriptRuns)
    .set({ status: 'running', startedAt: sql`NOW()` })
    .where(and(eq(scriptRuns.id, candidate.id), eq(scriptRuns.status, 'queued')));

  // mysql2 reports affectedRows; a zero means another runner won the race.
  const affected = (result as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0;
  if (affected === 0) return null;
  return getRun(candidate.id);
}

/**
 * A short-lived token carrying only the script's declared scopes.
 *
 * It acts as the assistant bot, so everything the script writes is attributable
 * to a bot identity in the same audit trail an agent's writes land in — a script
 * must not be able to act as the person who happened to press Run.
 */
export async function mintRunToken(run: ScriptRunRow, script: ScriptRow): Promise<string | null> {
  const botUserId = await getBotUserId();
  if (botUserId === null) {
    logger.warn({ runId: run.id }, 'scripts: no bot user seeded — run cannot be given a token');
    return null;
  }
  const { id, token } = await createApiToken({
    name: `script-run-${run.id} (${script.name})`,
    scopes: script.scopes as Scope[],
    actsAsUserId: botUserId,
    createdBy: run.triggeredBy,
    expiresAt: new Date(Date.now() + RUN_TOKEN_TTL_MS),
  });
  await db.update(scriptRuns).set({ tokenId: id }).where(eq(scriptRuns.id, run.id));
  return token;
}

/** Record the outcome and revoke the run's token — always, including on failure. */
export async function finishRun(
  runId: number,
  outcome: {
    status: 'succeeded' | 'failed' | 'timeout';
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
  },
): Promise<void> {
  const run = await getRun(runId);
  await db
    .update(scriptRuns)
    .set({
      status: outcome.status,
      exitCode: outcome.exitCode ?? null,
      // Capped: a runaway print loop must not put megabytes per run in the database.
      stdout: truncate(outcome.stdout),
      stderr: truncate(outcome.stderr),
      error: outcome.error ?? null,
      finishedAt: sql`NOW()`,
    })
    .where(eq(scriptRuns.id, runId));

  // The credential dies with the run. A token that outlived its script would be
  // a standing key with that script's scopes and nobody watching it.
  if (run?.tokenId) await revokeApiToken(run.tokenId);
}

const MAX_OUTPUT_CHARS = 100_000;

function truncate(value?: string): string | null {
  if (value === undefined) return null;
  return value.length > MAX_OUTPUT_CHARS
    ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n…output truncated…`
    : value;
}
