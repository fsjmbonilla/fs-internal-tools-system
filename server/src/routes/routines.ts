import { desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { routineRuns, routines } from '../db/schema/index.js';
import { requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { SCOPES, type Scope } from '../services/apiTokenService.js';
import { channelForReading } from '../services/access.js';
import { runRoutine } from '../services/routineRunner.js';
import { deleteScript } from '../services/scriptService.js';
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
  // Optional at the schema so a drive_script routine can omit it; an 'ai'
  // routine still cannot — requireKindFields below enforces that.
  prompt: z.string().min(1).max(20_000).optional(),
  schedule: z.string().min(1).max(120),
  scopes: z.array(scopeSchema).default([]),
  outputChannelId: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  kind: z.enum(['ai', 'drive_script']).optional(),
  driveFileId: z.string().min(1).max(120).nullable().optional(),
  /** Display only — the picker knows the name, the id alone is unreadable. */
  driveFileName: z.string().min(1).max(300).nullable().optional(),
  /** Scopes the queued script run's token will carry — same vocabulary as scripts. */
  scriptScopes: z.array(scopeSchema).nullable().optional(),
});

/**
 * What each kind requires, checked against the row as it will be after the
 * write — a patch may change `kind` without resending the fields the new kind
 * needs, or blank a field the current kind depends on.
 */
function requireKindFields(effective: {
  kind: 'ai' | 'drive_script';
  prompt: string | null | undefined;
  driveFileId: string | null | undefined;
}): void {
  if (effective.kind === 'ai' && !effective.prompt) {
    throw new AppError(400, 'validation_error', 'An AI routine needs a prompt');
  }
  if (effective.kind === 'drive_script' && !effective.driveFileId) {
    throw new AppError(400, 'validation_error', 'A Drive script routine needs a driveFileId');
  }
}

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
  const kind = input.kind ?? 'ai';
  requireKindFields({ kind, prompt: input.prompt, driveFileId: input.driveFileId });
  await validateInput(input, req.auth!.userId, req.auth!.role === 'admin');

  const [{ id }] = await db
    .insert(routines)
    .values({
      name: input.name,
      kind,
      prompt: input.prompt ?? '',
      schedule: input.schedule,
      scopes: input.scopes,
      driveFileId: input.driveFileId ?? null,
      driveFileName: input.driveFileName ?? null,
      scriptScopes: input.scriptScopes ?? null,
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
  const existing = await requireOwnRoutine(id, req.auth!.userId, req.auth!.role === 'admin');
  const input = req.valid as z.infer<typeof patchBody>;
  requireKindFields({
    kind: input.kind ?? existing.kind,
    prompt: input.prompt !== undefined ? input.prompt : existing.prompt,
    driveFileId: input.driveFileId !== undefined ? input.driveFileId : existing.driveFileId,
  });
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
  const row = await requireOwnRoutine(id, req.auth!.userId, req.auth!.role === 'admin');
  unscheduleRoutine(id);
  await db.delete(routines).where(eq(routines.id, id));
  // A drive_script routine's managed scripts row exists only to feed the
  // runner; without the routine it is an orphan, so it goes too.
  if (row.managedScriptId !== null) await deleteScript(row.managedScriptId);
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
