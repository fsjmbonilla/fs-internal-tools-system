import { and, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { channelMembers, channels } from '../db/schema/index.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import {
  addChannelMember,
  createChannel,
  getVisibleChannel,
  isChannelMember,
  listVisibleChannels,
  removeChannelMember,
} from '../services/channelService.js';
import {
  editMessage,
  getMessagesBefore,
  getUnreadCounts,
  markRead,
  searchMessages,
  sendMessage,
  softDeleteMessage,
  toggleReaction,
} from '../services/messageService.js';

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

function parseId(raw: string | string[]): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  return id;
}

async function requireVisibleChannel(channelId: number, userId: number, isAdmin: boolean) {
  const channel = await getVisibleChannel(channelId, userId, isAdmin);
  if (!channel) throw new AppError(404, 'not_found', 'Not found');
  return channel;
}

async function requireOwnerOrAdmin(channelId: number, userId: number, isAdmin: boolean) {
  if (isAdmin) return;
  const [row] = await db
    .select()
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
  if (row?.role !== 'owner') throw new AppError(404, 'not_found', 'Not found');
}

channelsRouter.get('/', async (req, res) => {
  const isAdmin = req.auth!.role === 'admin';
  const [list, unread] = await Promise.all([
    listVisibleChannels(req.auth!.userId, isAdmin),
    getUnreadCounts(req.auth!.userId),
  ]);
  res.json({ channels: list.map((c) => ({ ...c, unreadCount: unread[c.id] ?? 0 })) });
});

const createBody = z.object({
  name: z.string().min(1).max(80),
  isPrivate: z.boolean(),
  topic: z.string().max(255).optional(),
  departmentId: z.number().int().positive().optional(),
});

channelsRouter.post('/', validate(createBody), async (req, res) => {
  const input = req.valid as z.infer<typeof createBody>;
  const channel = await createChannel({ ...input, createdBy: req.auth!.userId });
  res.status(201).json({ channel });
});

channelsRouter.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const channel = await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  res.json({ channel });
});

const patchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  topic: z.string().max(255).nullable().optional(),
});

channelsRouter.patch('/:id', validate(patchBody), async (req, res) => {
  const id = parseId(req.params.id);
  const isAdmin = req.auth!.role === 'admin';
  await requireVisibleChannel(id, req.auth!.userId, isAdmin);
  await requireOwnerOrAdmin(id, req.auth!.userId, isAdmin);
  await db.update(channels).set(req.valid as z.infer<typeof patchBody>).where(eq(channels.id, id));
  const channel = await getVisibleChannel(id, req.auth!.userId, true);
  res.json({ channel });
});

const memberBody = z.object({ userId: z.number().int().positive() });

channelsRouter.post('/:id/members', validate(memberBody), async (req, res) => {
  const id = parseId(req.params.id);
  const isAdmin = req.auth!.role === 'admin';
  await requireVisibleChannel(id, req.auth!.userId, isAdmin);
  await requireOwnerOrAdmin(id, req.auth!.userId, isAdmin);
  await addChannelMember(id, (req.valid as z.infer<typeof memberBody>).userId);
  res.status(201).json({ ok: true });
});

channelsRouter.delete('/:id/members/:userId', async (req, res) => {
  const id = parseId(req.params.id);
  const memberId = parseId(req.params.userId);
  const isAdmin = req.auth!.role === 'admin';
  await requireVisibleChannel(id, req.auth!.userId, isAdmin);
  await requireOwnerOrAdmin(id, req.auth!.userId, isAdmin);
  await removeChannelMember(id, memberId);
  res.json({ ok: true });
});

const historyQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

channelsRouter.get('/:id/messages', validate(historyQuery, 'query'), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  const { before, limit } = req.valid as z.infer<typeof historyQuery>;
  const list = await getMessagesBefore(id, before ?? null, limit);
  res.json({ messages: list });
});

const sendBody = z.object({
  body: z.string().min(1).max(4000),
  attachmentIds: z.array(z.number().int().positive()).max(10).optional(),
});

channelsRouter.post('/:id/messages', validate(sendBody), async (req, res) => {
  const id = parseId(req.params.id);
  const isAdmin = req.auth!.role === 'admin';
  await requireVisibleChannel(id, req.auth!.userId, isAdmin);
  if (!isAdmin && !(await isChannelMember(id, req.auth!.userId))) {
    throw new AppError(404, 'not_found', 'Not found');
  }
  const sendInput = req.valid as z.infer<typeof sendBody>;
  const message = await sendMessage(id, req.auth!.userId, sendInput.body, sendInput.attachmentIds);
  res.status(201).json({ message });
});

const readBody = z.object({ messageId: z.number().int().positive() });

channelsRouter.post('/:id/read', validate(readBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  await markRead(id, req.auth!.userId, (req.valid as z.infer<typeof readBody>).messageId);
  res.json({ ok: true });
});

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

const editBody = z.object({ body: z.string().min(1).max(4000) });

messagesRouter.patch('/:id', validate(editBody), async (req, res) => {
  const id = parseId(req.params.id);
  const ok = await editMessage(id, req.auth!.userId, (req.valid as z.infer<typeof editBody>).body);
  if (!ok) throw new AppError(403, 'forbidden', 'Only the author can edit this message');
  res.json({ ok: true });
});

messagesRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const ok = await softDeleteMessage(id, req.auth!.userId);
  if (!ok) throw new AppError(403, 'forbidden', 'Only the author can delete this message');
  res.json({ ok: true });
});

const reactionBody = z.object({ emoji: z.string().min(1).max(32) });

messagesRouter.put('/:id/reactions', validate(reactionBody), async (req, res) => {
  const id = parseId(req.params.id);
  const result = await toggleReaction(
    id,
    req.auth!.userId,
    (req.valid as z.infer<typeof reactionBody>).emoji,
  );
  res.json(result);
});

export const searchRouter = Router();
searchRouter.use(requireAuth);

const searchQuery = z.object({
  q: z.string().min(1).max(200),
  channelId: z.coerce.number().int().positive().optional(),
});

searchRouter.get('/messages', validate(searchQuery, 'query'), async (req, res) => {
  const { q, channelId } = req.valid as z.infer<typeof searchQuery>;
  const results = await searchMessages(req.auth!.userId, req.auth!.role === 'admin', q, channelId);
  res.json({ messages: results });
});
