import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { registerDeviceToken, unregisterDeviceToken } from '../services/deviceTokenService.js';

export const pushRouter = Router();
pushRouter.use(requireAuth);

const registerBody = z.object({
  token: z.string().min(10).max(255),
  platform: z.enum(['ios', 'android', 'web']),
});

pushRouter.post('/tokens', validate(registerBody), async (req, res) => {
  const { token, platform } = req.valid as z.infer<typeof registerBody>;
  await registerDeviceToken(req.auth!.userId, token, platform);
  res.status(201).json({ ok: true });
});

const unregisterBody = z.object({
  token: z.string().min(10).max(255),
});

pushRouter.delete('/tokens', validate(unregisterBody), async (req, res) => {
  const { token } = req.valid as z.infer<typeof unregisterBody>;
  await unregisterDeviceToken(req.auth!.userId, token);
  res.json({ ok: true });
});
