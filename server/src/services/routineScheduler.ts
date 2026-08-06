import { Cron } from 'croner';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { routines } from '../db/schema/index.js';
import { logger } from '../logger.js';
import { runRoutine, type RoutineRow } from './routineRunner.js';

/**
 * The cron scheduler for routines.
 *
 * State lives in the database and the timers are rebuilt from it at boot, which
 * is what makes a restart safe: nothing is remembered in the process that would
 * be lost, and nothing fires twice because a schedule was reloaded — croner
 * computes the next occurrence from the clock, not from what already happened.
 *
 * One process owns the timers. Running two API instances would fire every
 * routine twice, so scaling out means moving this behind a leader election or a
 * scheduler service — the same conversation as the Socket.IO adapter and the
 * sheet lock. Written down here because it is invisible until the second task
 * starts and everything silently doubles.
 */

const jobs = new Map<number, Cron>();

/** Is this a schedule croner will accept? Used to reject one at the route edge. */
export function isValidSchedule(expression: string): boolean {
  try {
    const probe = new Cron(expression, { paused: true });
    const next = probe.nextRun();
    probe.stop();
    return next !== null;
  } catch {
    return false;
  }
}

/** When this schedule next fires, for the UI. Null if it never will. */
export function nextRunAt(expression: string): Date | null {
  try {
    const probe = new Cron(expression, { paused: true });
    const next = probe.nextRun();
    probe.stop();
    return next;
  } catch {
    return null;
  }
}

function start(routine: RoutineRow): void {
  stop(routine.id);
  if (!routine.enabled) return;
  try {
    const job = new Cron(routine.schedule, { protect: true }, () => {
      // `protect` skips a tick if the previous one is still running, so a slow
      // routine cannot pile up overlapping runs of itself.
      void runRoutine(routine, 'schedule').catch((err) =>
        logger.error({ err, routineId: routine.id }, 'scheduled routine threw'),
      );
    });
    jobs.set(routine.id, job);
  } catch (err) {
    // A bad expression must not take the scheduler down with it — the other
    // routines are unrelated and still need to run.
    logger.error({ err, routineId: routine.id }, 'routine has an invalid schedule; not scheduled');
  }
}

function stop(routineId: number): void {
  jobs.get(routineId)?.stop();
  jobs.delete(routineId);
}

/** Re-read one routine and re-arm it. Called after any change to it. */
export async function rescheduleRoutine(routineId: number): Promise<void> {
  const [row] = await db.select().from(routines).where(eq(routines.id, routineId));
  if (!row) {
    stop(routineId);
    return;
  }
  start(row);
}

export function unscheduleRoutine(routineId: number): void {
  stop(routineId);
}

/** Rebuild every timer from the database. Called once at boot. */
export async function startScheduler(): Promise<number> {
  const rows = await db.select().from(routines).where(eq(routines.enabled, true));
  for (const row of rows) start(row);
  logger.info({ count: rows.length }, 'routine scheduler started');
  return rows.length;
}

/** Test-only: timers outlive a truncation, so resetDb has to clear them. */
export function stopAllRoutines(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
}

/** How many routines are armed right now — for diagnostics and tests. */
export function scheduledCount(): number {
  return jobs.size;
}
