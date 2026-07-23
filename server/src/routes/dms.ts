import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { findOrCreateDm, listMyDms } from '../services/channelService.js';

export const dmsRouter = Router();
dmsRouter.use(requireAuth);

dmsRouter.get('/', async (req, res) => {
  const dms = await listMyDms(req.auth!.userId);
  res.json({ dms });
});

const dmBody = z.object({ userId: z.number().int().positive() });

dmsRouter.post('/', validate(dmBody), async (req, res) => {
  const { userId } = req.valid as z.infer<typeof dmBody>;
  const channel = await findOrCreateDm(req.auth!.userId, userId);
  res.status(201).json({ channel });
});
