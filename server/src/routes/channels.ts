import { desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { channels, messages, users } from '../db/schema/index.js';
import { validate } from '../middleware/validate.js';

export const channelsRouter = Router();

channelsRouter.get('/', async (_req, res) => {
  const rows = await db
    .select({ id: channels.id, name: channels.name, createdAt: channels.createdAt })
    .from(channels)
    .orderBy(channels.name);
  res.json(rows);
});

const messageParams = z.object({ id: z.coerce.number().int().positive() });

channelsRouter.get('/:id/messages', validate(messageParams, 'params'), async (req, res) => {
  const { id } = req.valid as z.infer<typeof messageParams>;
  const rows = await db
    .select({
      id: messages.id,
      body: messages.body,
      createdAt: messages.createdAt,
      userId: users.id,
      displayName: users.displayName,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(eq(messages.channelId, id))
    .orderBy(desc(messages.createdAt))
    .limit(50);
  res.json(rows);
});
