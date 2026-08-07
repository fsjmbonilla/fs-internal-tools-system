import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { checkAiBudget, recordAiUsage, type AiUsageRecord } from '../services/aiBudgetService.js';
import { isAiConfigured } from '../services/aiService.js';
import {
  draftReply,
  forwardMail,
  getMail,
  listMail,
  replyMail,
  saveDraft,
  sendMail,
} from '../services/gmailService.js';

/**
 * The caller's own Gmail. Personal data — `requireUserAuth`, like notes and
 * calendar; agents go through the tool registry and its gmail scopes instead.
 */
export const gmailRouter = Router();
gmailRouter.use(requireAuth, requireUserAuth);

gmailRouter.get('/messages', async (req, res) => {
  const query = z
    .object({
      q: z.string().max(500).optional(),
      label: z.string().max(100).optional(),
      pageToken: z.string().max(500).optional(),
    })
    .safeParse(req.query);
  if (!query.success) throw new AppError(400, 'validation_error', 'Bad query');
  const result = await listMail(req.auth!.userId, {
    q: query.data.q,
    labelId: query.data.label,
    pageToken: query.data.pageToken,
  });
  res.json(result);
});

gmailRouter.get('/messages/:id', async (req, res) => {
  const id = z.string().min(1).max(64).parse(req.params.id);
  const message = await getMail(req.auth!.userId, id);
  if (!message) throw new AppError(404, 'not_found', 'Not found');
  res.json({ message });
});

const replyBody = z.object({
  body: z.string().min(1).max(100_000),
  all: z.boolean().optional(),
});

// To/Cc/Subject/threading headers derive from the original message server-side —
// the client never gets to write reply headers.
gmailRouter.post('/messages/:id/reply', validate(replyBody), async (req, res) => {
  const id = z.string().min(1).max(64).parse(req.params.id);
  const { body, all } = req.valid as z.infer<typeof replyBody>;
  const sent = await replyMail(req.auth!.userId, { messageId: id, body, all });
  res.status(201).json({ sent });
});

const forwardBody = z.object({
  to: z.string().email(),
  note: z.string().max(10_000).optional(),
});

gmailRouter.post('/messages/:id/forward', validate(forwardBody), async (req, res) => {
  const id = z.string().min(1).max(64).parse(req.params.id);
  const { to, note } = req.valid as z.infer<typeof forwardBody>;
  const sent = await forwardMail(req.auth!.userId, { messageId: id, to, note });
  res.status(201).json({ sent });
});

const draftBody = z.object({
  to: z.string().email().optional(),
  subject: z.string().max(500).optional(),
  body: z.string().min(1).max(100_000),
  replyToMessageId: z.string().max(64).optional(),
});

gmailRouter.post('/drafts', validate(draftBody), async (req, res) => {
  const input = req.valid as z.infer<typeof draftBody>;
  const draft = await saveDraft(req.auth!.userId, input);
  res.status(201).json({ draft });
});

const draftReplyBody = z.object({ instruction: z.string().max(2000).optional() });

/**
 * AI reply suggestion — a paid call, so it sits behind the same gate as every
 * other AI call (invariant 7): checkAiBudget before dispatch, an ai_usage row
 * after, booked to the NULL channel bucket like the dashboard summary.
 */
gmailRouter.post('/messages/:id/draft-reply', validate(draftReplyBody), async (req, res) => {
  if (!isAiConfigured()) {
    throw new AppError(503, 'ai_unconfigured', 'No AI provider is configured');
  }
  const id = z.string().min(1).max(64).parse(req.params.id);
  const { instruction } = req.valid as z.infer<typeof draftReplyBody>;
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
  let usage: AiUsageRecord | undefined;
  try {
    const draft = await draftReply(req.auth!.userId, { messageId: id, instruction }, (u) => {
      usage = u;
    });
    if (usage) await recordAiUsage(null, usage);
    res.json({ draft });
  } catch (err) {
    // Record before failing: the dispatched call must consume the interval.
    if (usage) await recordAiUsage(null, usage);
    if (err instanceof AppError) throw err;
    throw new AppError(502, 'ai_error', err instanceof Error ? err.message : 'The AI request failed');
  }
});

const sendBody = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(100_000),
});

gmailRouter.post('/send', validate(sendBody), async (req, res) => {
  const input = req.valid as z.infer<typeof sendBody>;
  const sent = await sendMail(req.auth!.userId, input);
  res.status(201).json({ sent });
});
