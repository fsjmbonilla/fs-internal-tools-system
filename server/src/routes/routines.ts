import { desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { routineRuns, routines } from '../db/schema/index.js';
import { requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { SCOPES, type Scope } from '../services/apiTokenService.js';
import { channelForReading } from '../services/agentAuth.js';
import { runRoutine } from '../services/routineRunner.js';
import {
  isValidSchedule,
  nextRunAt,
  rescheduleRoutine,
  unscheduleRoutine,
} from '../services/routineScheduler.js';

/**
 * AI Routines.
 *
 * A routine belongs to the person who made it: they see and change their own,
 * and an admin sees all of them. `requireUserAuth` keeps service tokens out —
 * an agent that could create a routine could grant itself a standing schedule
 * with scopes of its own choosing, which is the whole boundary this respects.
 */
export const routinesRouter = Router();
routinesRouter.use(requireAuth, requireUserAuth);

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

/** Yours, or anyone's if you are an admin. 404 rather than 403 for someone else's. */
async function requireOwnRoutine(id: number, userId: number, isAdmin: boolean) {
  const [row] = await db.select().from(routines).where(eq(routines.id, id));
  if (!row) throw new AppError(404, 'not_found', 'Not found');
  if (!isAdmin && row.ownerId !== userId) throw new AppError(404, 'not_found', 'Not found');
  return row;
}

const scopeSchema = z.enum(SCOPES as unknown as [Scope, ...Scope[]]);

const createBody = z.object({
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  schedule: z.string().min(1).max(120),
  scopes: z.array(scopeSchema).default([]),
  outputChannelId: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});

/**
 * Reject a schedule croner cannot parse, and an output channel the caller cannot
 * see. The second matters: without it, an id alone would tell you a private
 * channel exists — and would aim a routine's output at it.
 */
async function validateInput(
  input: { schedule?: string; outputChannelId?: number | null },
  userId: number,
  isAdmin: boolean,
): Promise<void> {
  if (input.schedule !== undefined && !isValidSchedule(input.schedule)) {
    throw new AppError(400, 'invalid_schedule', 'That is not a schedule this system can run');
  }
  if (input.outputChannelId !== undefined && input.outputChannelId !== null) {
    if (!(await channelForReading(input.outputChannelId, { userId, isAdmin }))) {
      throw new AppError(404, 'not_found', 'Not found');
    }
  }
}

function withNextRun<T extends { schedule: string; enabled: boolean }>(routine: T) {
  return { ...routine, nextRunAt: routine.enabled ? nextRunAt(routine.schedule) : null };
}

routinesRouter.get('/', async (req, res) => {
  const isAdmin = req.auth!.role === 'admin';
  const rows = await db.select().from(routines).orderBy(routines.name);
  const mine = isAdmin ? rows : rows.filter((r) => r.ownerId === req.auth!.userId);
  res.json({ routines: mine.map(withNextRun) });
});

routinesRouter.post('/', validate(createBody), async (req, res) => {
  const input = req.valid as z.infer<typeof createBody>;
  await validateInput(input, req.auth!.userId, req.auth!.role === 'admin');

  const [{ id }] = await db
    .insert(routines)
    .values({
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      scopes: input.scopes,
      outputChannelId: input.outputChannelId ?? null,
      enabled: input.enabled ?? true,
      ownerId: req.auth!.userId,
    })
    .$returningId();
  await rescheduleRoutine(id);
  const [row] = await db.select().from(routines).where(eq(routines.id, id));
  res.status(201).json({ routine: withNextRun(row) });
});

routinesRouter.get('/:id', async (req, res) => {
  const row = await requireOwnRoutine(
    parseId(req.params.id),
    req.auth!.userId,
    req.auth!.role === 'admin',
  );
  res.json({ routine: withNextRun(row) });
});

const patchBody = createBody.partial();

routinesRouter.patch('/:id', validate(patchBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireOwnRoutine(id, req.auth!.userId, req.auth!.role === 'admin');
  const input = req.valid as z.infer<typeof patchBody>;
  await validateInput(input, req.auth!.userId, req.auth!.role === 'admin');

  await db.update(routines).set(input).where(eq(routines.id, id));
  // Re-arm from the stored row: a changed schedule or a flipped switch has to
  // take effect now, not at the next restart.
  await rescheduleRoutine(id);
  const [row] = await db.select().from(routines).where(eq(routines.id, id));
  res.json({ routine: withNextRun(row) });
});

routinesRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  await requireOwnRoutine(id, req.auth!.userId, req.auth!.role === 'admin');
  unscheduleRoutine(id);
  await db.delete(routines).where(eq(routines.id, id));
  res.json({ ok: true });
});

/** Run now. Synchronous on purpose: the caller is watching and wants the result. */
routinesRouter.post('/:id/run', async (req, res) => {
  const routine = await requireOwnRoutine(
    parseId(req.params.id),
    req.auth!.userId,
    req.auth!.role === 'admin',
  );
  const run = await runRoutine(routine, 'manual');
  res.status(201).json({ run });
});

routinesRouter.get('/:id/runs', async (req, res) => {
  const id = parseId(req.params.id);
  await requireOwnRoutine(id, req.auth!.userId, req.auth!.role === 'admin');
  const runs = await db
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.routineId, id))
    .orderBy(desc(routineRuns.id))
    .limit(50);
  res.json({ runs });
});
