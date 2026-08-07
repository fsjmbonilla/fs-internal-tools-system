import { Router } from 'express';
import { requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { checkAiBudget, recordAiUsage, type AiUsageRecord } from '../services/aiBudgetService.js';
import { isAiConfigured } from '../services/aiService.js';
import { AI_NOT_CONFIGURED, getTodayDashboard, summarizeDay } from '../services/dashboardService.js';

/**
 * The "Today" dashboard. `requireUserAuth` because this is personal data — the
 * caller's own calendar, their Shared-with-me, their unread counts. An agent
 * has no "today" to see, and a service token must never read a person's.
 */
export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireUserAuth);

dashboardRouter.get('/today', async (req, res) => {
  const dashboard = await getTodayDashboard(req.auth!.userId, req.auth!.role === 'admin');
  res.json(dashboard);
});

/**
 * The AI day summary. A paid AI call, so it lives behind the same gate as
 * triage (invariant 7): `checkAiBudget()` before dispatch, an `ai_usage` row
 * with real token counts after — recorded whatever the call returned. Like a
 * script assist, a summary belongs to no channel, so it books against the
 * NULL channel bucket.
 */
dashboardRouter.post('/summary', async (req, res) => {
  // Provider-switchable, exactly like triage: whichever of OpenAI/Anthropic
  // AI_PROVIDER selects answers, and this only fails when NO provider is
  // configured at all.
  if (!isAiConfigured()) throw new AppError(503, 'ai_unconfigured', AI_NOT_CONFIGURED);

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

  // The prompt is built from the same aggregation the widgets render — counts
  // and titles only, and never notes (dashboardService does not touch them).
  const dashboard = await getTodayDashboard(req.auth!.userId, req.auth!.role === 'admin');

  let usage: AiUsageRecord | undefined;
  try {
    const summary = await summarizeDay(dashboard, (u) => (usage = u));
    if (usage) await recordAiUsage(null, usage);
    res.json({ summary });
  } catch (err) {
    // Record before failing: the dispatched call must consume the interval, or
    // a broken provider gets retried at full speed.
    if (usage) await recordAiUsage(null, usage);
    throw new AppError(502, 'ai_error', err instanceof Error ? err.message : 'The AI request failed');
  }
});
