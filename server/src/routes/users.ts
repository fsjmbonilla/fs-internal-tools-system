import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { toPublicUser } from '../services/authService.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

usersRouter.get('/', async (_req, res) => {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(users.displayName);
  res.json({ users: rows.map(toPublicUser) });
});

const mePatch = z.object({
  displayName: z.string().min(1).max(100).optional(),
  avatarUrl: z.url().max(500).nullable().optional(),
});

usersRouter.patch('/me', validate(mePatch), async (req, res) => {
  const patch = req.valid as z.infer<typeof mePatch>;
  await db.update(users).set(patch).where(eq(users.id, req.auth!.userId));
  const [row] = await db.select().from(users).where(eq(users.id, req.auth!.userId));
  res.json({ user: toPublicUser(row) });
});
