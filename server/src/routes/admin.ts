import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { events } from '../services/events.js';
import { countNotes, transferNotes } from '../services/noteService.js';
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

const transferBody = z.object({ toUserId: z.number().int().positive() });

/**
 * Hand one person's notes to another. The offboarding path.
 *
 * Admin-only, and a transfer rather than a grant: it moves ownership and returns
 * a count, never any content. That keeps "notes are private" true — an admin can
 * rescue a departing colleague's notes without gaining the ability to read
 * anyone's.
 */
adminRouter.post('/users/:id/notes/transfer', validate(transferBody), async (req, res) => {
  const fromId = Number(req.params.id);
  if (!Number.isInteger(fromId) || fromId <= 0) {
    throw new AppError(400, 'validation_error', 'Bad user id');
  }
  const { toUserId } = req.valid as z.infer<typeof transferBody>;
  if (fromId === toUserId) {
    throw new AppError(400, 'invalid_target', 'Source and destination are the same person');
  }

  const [from] = await db.select({ id: users.id }).from(users).where(eq(users.id, fromId));
  if (!from) throw new AppError(404, 'not_found', 'Not found');
  const [to] = await db
    .select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, toUserId));
  // Handing notes to a deactivated account would make them unreachable again.
  if (!to || !to.isActive) throw new AppError(404, 'not_found', 'Not found');

  const transferred = await transferNotes(fromId, toUserId);
  // Private content changing hands is worth a record, since there is no audit
  // table yet: who did it, whose notes, and how many.
  logger.info(
    { actor: req.auth!.userId, from: fromId, to: toUserId, transferred },
    'notes ownership transferred',
  );
  res.json({ transferred });
});

/** A count, so the console can say what a transfer would move. Never content. */
adminRouter.get('/users/:id/notes/count', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, 'validation_error', 'Bad user id');
  }
  res.json({ count: await countNotes(id) });
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
