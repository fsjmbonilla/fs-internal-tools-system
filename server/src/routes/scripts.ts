import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { checkAiBudget, recordAiUsage } from '../services/aiBudgetService.js';
import type { TriageUsage } from '../services/ai/triage.js';
import { SCOPES, type Scope } from '../services/apiTokenService.js';
import {
  AI_NOT_CONFIGURED,
  assistScript,
  isScriptAssistConfigured,
} from '../services/scriptAssistService.js';
import {
  createScript,
  deleteScript,
  getRun,
  getScript,
  listRuns,
  listScripts,
  queueRun,
  updateScript,
} from '../services/scriptService.js';

/**
 * Scripts: staff-written automation, executed by the runner service.
 *
 * **Admin-only, deliberately**, as the master plan specifies for the first cut.
 * A script runs server-side with a scoped token; the ability to write one is the
 * ability to act as the platform, so it starts closed and can be widened once
 * there is a reason to. `requireUserAuth` on top of that means a service token
 * cannot create or run scripts either — an agent that could write its own
 * privileged script would route around its own scopes.
 */
export const scriptsRouter = Router();
scriptsRouter.use(requireAuth, requireUserAuth, requireAdmin);

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

const scopeSchema = z.enum(SCOPES as unknown as [Scope, ...Scope[]]);

const createBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  source: z.string().max(200_000),
  // A script with no scopes is legitimate — plenty of useful work is pure
  // computation that never calls back into the API.
  scopes: z.array(scopeSchema).max(SCOPES.length).default([]),
});

scriptsRouter.get('/', async (_req, res) => {
  res.json({ scripts: await listScripts() });
});

scriptsRouter.post('/', validate(createBody), async (req, res) => {
  const input = req.valid as z.infer<typeof createBody>;
  const script = await createScript({ ...input, userId: req.auth!.userId });
  res.status(201).json({ script });
});

const assistBody = z.object({
  source: z.string().max(100_000),
  instruction: z.string().min(1).max(2000),
  mode: z.enum(['analyze', 'generate', 'edit']),
});

/**
 * The editor's AI assistant. A paid AI call, so it lives behind the same gate
 * as triage (invariant 7): `checkAiBudget()` before dispatch, an `ai_usage` row
 * with real token counts after — recorded whatever the call returned, because a
 * dispatched call is billable either way. An assist belongs to no channel, so
 * it books against the NULL channel bucket, exactly what a channel-less routine
 * would use.
 */
scriptsRouter.post('/assist', validate(assistBody), async (req, res) => {
  const input = req.valid as z.infer<typeof assistBody>;

  // Clear failure when the deployment has no AI backend — whichever provider
  // AI_PROVIDER selects, the same switch triage runs on.
  if (!isScriptAssistConfigured()) throw new AppError(503, 'ai_unconfigured', AI_NOT_CONFIGURED);

  const budget = await checkAiBudget(null);
  if (!budget.ok) {
    throw new AppError(
      429,
      'ai_budget_exceeded',
      budget.reason === 'daily_cap'
        ? "Today's AI call allowance is used up — try again tomorrow."
        : 'Another AI call just ran — wait a minute and try again.',
    );
  }

  let usage: TriageUsage | undefined;
  try {
    const result = await assistScript({ ...input, onUsage: (u) => (usage = u) });
    if (usage) await recordAiUsage(null, usage);
    res.json(result);
  } catch (err) {
    // Record before failing: the dispatched call must consume the interval, or
    // a broken provider gets retried at full speed.
    if (usage) await recordAiUsage(null, usage);
    throw new AppError(502, 'ai_error', err instanceof Error ? err.message : 'The AI request failed');
  }
});

scriptsRouter.get('/:id', async (req, res) => {
  const script = await getScript(parseId(req.params.id));
  if (!script) throw new AppError(404, 'not_found', 'Not found');
  res.json({ script });
});

const patchBody = createBody.partial();

scriptsRouter.patch('/:id', validate(patchBody), async (req, res) => {
  const script = await updateScript(
    parseId(req.params.id),
    req.auth!.userId,
    req.valid as z.infer<typeof patchBody>,
  );
  if (!script) throw new AppError(404, 'not_found', 'Not found');
  res.json({ script });
});

scriptsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!(await getScript(id))) throw new AppError(404, 'not_found', 'Not found');
  await deleteScript(id);
  res.json({ ok: true });
});

scriptsRouter.post('/:id/run', async (req, res) => {
  const id = parseId(req.params.id);
  if (!(await getScript(id))) throw new AppError(404, 'not_found', 'Not found');
  // Queued, not executed. Nothing in the API process ever runs user code.
  const run = await queueRun(id, req.auth!.userId);
  res.status(202).json({ run });
});

scriptsRouter.get('/:id/runs', async (req, res) => {
  const id = parseId(req.params.id);
  if (!(await getScript(id))) throw new AppError(404, 'not_found', 'Not found');
  res.json({ runs: await listRuns(id) });
});

export const scriptRunsRouter = Router();
scriptRunsRouter.use(requireAuth, requireUserAuth, requireAdmin);

scriptRunsRouter.get('/:id', async (req, res) => {
  const run = await getRun(parseId(req.params.id));
  if (!run) throw new AppError(404, 'not_found', 'Not found');
  res.json({ run });
});
