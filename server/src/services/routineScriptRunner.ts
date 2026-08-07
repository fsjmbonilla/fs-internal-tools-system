import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { routineRuns, routines } from '../db/schema/index.js';
import { logger } from '../logger.js';
import type { Scope } from './apiTokenService.js';
import { exportFile } from './driveService.js';
import type { RoutineRow, RoutineRunRow } from './routineRunner.js';
import { createScript, getScript, queueRun, updateScript } from './scriptService.js';

/**
 * The drive_script flavour of a routine: on the cron tick, fetch a Python file
 * from the owner's Google Drive and queue it through the SAME sandbox the
 * Scripts feature uses. Nothing here executes code — invariant 9 — this
 * process only moves source from Drive into a scripts row and inserts a
 * queued run for the runner service to claim.
 *
 * Why a managed scripts row rather than a snapshot on the run: the runner's
 * claim endpoint reads `scripts.source` at claim time, so queued source has to
 * live in a real scripts row. Each drive_script routine therefore maintains
 * exactly one row (named "[routine] <name>", tracked by
 * `routines.managed_script_id`), refreshed from Drive before every queue. The
 * scopes on that row — and so on the run's minted token — are the routine's
 * `scriptScopes`, enforced exactly as for a hand-written script.
 *
 * The routine run stays `running` until the runner reports back;
 * `scriptService.finishRun` finds it through `routine_runs.script_run_id` and
 * copies the outcome (status, stdout, stderr) into the transcript, so the
 * routine's own history is complete even if the script run is later deleted.
 *
 * No AI is involved: no model call, no token budget, no aiBudgetService.
 */

/** Source cap — a "script" bigger than this is data, not code. */
const MAX_SOURCE_BYTES = 200 * 1024;

function looksLikePython(name: string, mimeType: string): boolean {
  return /\.py$/i.test(name) || /python/i.test(mimeType);
}

export async function runDriveScriptRoutine(
  routine: RoutineRow,
  trigger: 'schedule' | 'manual',
): Promise<RoutineRunRow> {
  const [{ id: runId }] = await db
    .insert(routineRuns)
    .values({ routineId: routine.id, trigger, status: 'running' })
    .$returningId();

  const readBack = async (): Promise<RoutineRunRow> => {
    const [row] = await db.select().from(routineRuns).where(eq(routineRuns.id, runId));
    return row;
  };

  /** Everything that stops a run before it is ever queued lands here. */
  const fail = async (error: string): Promise<RoutineRunRow> => {
    await db
      .update(routineRuns)
      .set({ status: 'failed', error, finishedAt: sql`NOW()` })
      .where(eq(routineRuns.id, runId));
    return readBack();
  };

  if (!routine.driveFileId) {
    return fail('This routine has no Drive file configured — pick a script and save it');
  }

  // Always the OWNER's connection (Caller.googleUserId semantics): a routine
  // borrows the Google grant of the person who created it, never the caller's.
  let exported: { name: string; mimeType: string; data: Buffer } | null;
  try {
    exported = await exportFile(routine.ownerId, routine.driveFileId);
  } catch (err) {
    // Not connected, broken grant, missing Drive scope, oversized — driveService
    // already words these; the run records the message rather than throwing.
    const message = err instanceof Error ? err.message : 'Could not reach Google Drive';
    logger.warn({ err, routineId: routine.id }, 'drive_script routine could not fetch its file');
    return fail(message);
  }
  if (!exported) {
    return fail('The Drive file was not found — it may have been deleted or unshared');
  }
  if (!looksLikePython(exported.name, exported.mimeType)) {
    return fail(`"${exported.name}" is not a .py file — a drive_script routine only runs Python`);
  }
  if (exported.data.byteLength > MAX_SOURCE_BYTES) {
    return fail(
      `The script is ${Math.ceil(exported.data.byteLength / 1024)} KB — the limit is ${MAX_SOURCE_BYTES / 1024} KB of source`,
    );
  }

  const source = exported.data.toString('utf8');
  const scopes = (routine.scriptScopes ?? []) as Scope[];
  const name = `[routine] ${routine.name}`.slice(0, 200);

  // One managed row per routine, refreshed in place. If it was deleted from the
  // Scripts page, recreate it rather than failing the schedule forever.
  let scriptId = routine.managedScriptId;
  if (scriptId !== null && (await getScript(scriptId)) !== null) {
    await updateScript(scriptId, routine.ownerId, { name, source, scopes });
  } else {
    const script = await createScript({
      name,
      description: 'Managed by a routine — the source is re-fetched from Google Drive before every run.',
      source,
      scopes,
      userId: routine.ownerId,
    });
    scriptId = script.id;
    await db.update(routines).set({ managedScriptId: scriptId }).where(eq(routines.id, routine.id));
  }

  const run = await queueRun(scriptId, routine.ownerId);

  await db
    .update(routineRuns)
    .set({
      scriptRunId: run.id,
      transcript: [
        {
          type: 'script_queued',
          scriptRunId: run.id,
          fileName: exported.name,
          sourceBytes: exported.data.byteLength,
        },
      ],
    })
    .where(eq(routineRuns.id, runId));
  return readBack();
}
