import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { login, register, toPublicUser } from '../services/authService.js';
import { refreshSession, revokeRefreshToken } from '../services/tokenService.js';

export const authRouter = Router();

const registerBody = z.object({
  email: z.email(),
  password: z.string().min(12).max(200),
  displayName: z.string().min(1).max(100),
});
const loginBody = z.object({ email: z.email(), password: z.string().min(1) });
const refreshBody = z.object({ refreshToken: z.string().min(10) });

authRouter.post('/register', authLimiter, validate(registerBody), async (req, res) => {
  const input = req.valid as z.infer<typeof registerBody>;
  res.status(201).json(await register(input, req.headers['user-agent']));
});

authRouter.post('/login', authLimiter, validate(loginBody), async (req, res) => {
  const { email, password } = req.valid as z.infer<typeof loginBody>;
  res.json(await login(email, password, req.headers['user-agent']));
});

authRouter.post('/refresh', validate(refreshBody), async (req, res) => {
  const { refreshToken } = req.valid as z.infer<typeof refreshBody>;
  const session = await refreshSession(refreshToken, req.headers['user-agent']);
  if (!session) throw new AppError(401, 'invalid_refresh', 'Refresh token is invalid or reused');
  const [row] = await db.select().from(users).where(eq(users.id, session.userId));
  res.json({
    user: toPublicUser(row),
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  });
});

authRouter.post('/logout', validate(refreshBody), async (req, res) => {
  await revokeRefreshToken((req.valid as z.infer<typeof refreshBody>).refreshToken);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const [row] = await db.select().from(users).where(eq(users.id, req.auth!.userId));
  if (!row) throw new AppError(401, 'unauthenticated', 'User no longer exists');
  res.json({ user: toPublicUser(row) });
});
