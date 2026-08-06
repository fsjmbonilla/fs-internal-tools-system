import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { getMail, listMail, sendMail } from '../services/gmailService.js';

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
