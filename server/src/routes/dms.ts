import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { findOrCreateDm, listMyDms } from '../services/channelService.js';
import { getUnreadCounts } from '../services/messageService.js';

export const dmsRouter = Router();
dmsRouter.use(requireAuth);

dmsRouter.get('/', async (req, res) => {
  // Unread comes from the same single query the channel list uses; DMs are
  // channels, so they were already counted — just never exposed here.
  const [dms, unread] = await Promise.all([
    listMyDms(req.auth!.userId),
    getUnreadCounts(req.auth!.userId),
  ]);
  res.json({ dms: dms.map((d) => ({ ...d, unreadCount: unread[d.id] ?? 0 })) });
});

const dmBody = z.object({ userId: z.number().int().positive() });

dmsRouter.post('/', validate(dmBody), async (req, res) => {
  const { userId } = req.valid as z.infer<typeof dmBody>;
  const me = req.auth!.userId;
  if (userId === me) {
    throw new AppError(400, 'invalid_target', 'Cannot open a DM with yourself');
  }
  // The target has to exist and be active before we create anything: an unknown
  // id used to reach the channel_members foreign key and surface as a 500, and a
  // deactivated colleague is not someone to open a conversation with.
  const [target] = await db
    .select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId));
  if (!target || !target.isActive) throw new AppError(404, 'not_found', 'Not found');
  const channel = await findOrCreateDm(me, userId);
  res.status(201).json({ channel });
});
