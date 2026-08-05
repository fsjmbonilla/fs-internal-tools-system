import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { events } from '../services/events.js';
import { getAllowedDomains, setAllowedDomains } from '../services/settingsService.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/settings/allowed-domains', async (_req, res) => {
  res.json({ domains: await getAllowedDomains() });
});

const domainsBody = z.object({
  domains: z
    .array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'must be a bare domain like example.com'))
    .min(1)
    .max(50),
});

adminRouter.put('/settings/allowed-domains', validate(domainsBody), async (req, res) => {
  const { domains } = req.valid as z.infer<typeof domainsBody>;
  await setAllowedDomains(domains, req.auth!.userId);
  res.json({ domains: await getAllowedDomains() });
});

adminRouter.get('/users', async (_req, res) => {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.displayName);
  res.json({ users: rows });
});

const userPatch = z.object({
  role: z.enum(['admin', 'member']).optional(),
  isActive: z.boolean().optional(),
});

adminRouter.patch('/users/:id', validate(userPatch), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'validation_error', 'Bad user id');
  }
  if (id === req.auth!.userId) {
    throw new AppError(400, 'cannot_modify_self', 'Admins cannot change their own role or status');
  }
  const patch = req.valid as z.infer<typeof userPatch>;
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  if (!row) throw new AppError(404, 'not_found', 'Not found');
  await db.update(users).set(patch).where(eq(users.id, id));

  // A live socket carries the role and active flag it was handed at handshake,
  // so both of these changes have to reach it. Deactivation must not leave a
  // working session behind, and a demoted admin must not keep admin reach until
  // their token happens to expire.
  if (patch.isActive === false) {
    events.emit('access.userSessionsInvalidated', { userId: id, reason: 'deactivated' });
  } else if (patch.role !== undefined) {
    events.emit('access.userSessionsInvalidated', { userId: id, reason: 'role_changed' });
  }

  res.json({ ok: true });
});
