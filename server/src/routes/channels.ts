import { and, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { channelMembers, channels } from '../db/schema/index.js';
import { requireAuth, requireScope, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { getActiveCallForChannel } from '../services/callService.js';
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
import { getVisibleProject } from '../services/projectService.js';
import {
  columnBelongsToProject,
  getSupportConfig,
  resolveIntakeColumnId,
  upsertSupportConfig,
} from '../services/supportConfigService.js';

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

channelsRouter.get('/', requireScope('chat:read'), async (req, res) => {
  const isAdmin = req.auth!.role === 'admin';
  const [list, unread] = await Promise.all([
    listVisibleChannels(req.auth!.userId, isAdmin),
    getUnreadCounts(req.auth!.userId),
  ]);
  res.json({ channels: list.map((c) => ({ ...c, unreadCount: unread[c.id] ?? 0 })) });
});

const supportConfigBody = z.object({
  projectId: z.number().int().positive(),
  intakeColumnId: z.number().int().positive().optional(),
  instructions: z.string().max(2000).optional(),
});

const createBody = z.object({
  name: z.string().min(1).max(80),
  isPrivate: z.boolean(),
  topic: z.string().max(255).optional(),
  departmentId: z.number().int().positive().optional(),
  kind: z.enum(['standard', 'support']).optional(),
  supportConfig: supportConfigBody.optional(),
});

// A support channel files tickets into a project, so the creator must be able to see that
// project — otherwise creating one would leak the existence of a private project.
async function resolveSupportBinding(
  input: z.infer<typeof supportConfigBody>,
  userId: number,
  isAdmin: boolean,
): Promise<{ projectId: number; intakeColumnId: number; instructions?: string }> {
  const project = await getVisibleProject(input.projectId, userId, isAdmin);
  if (!project) throw new AppError(404, 'not_found', 'Not found');
  // A caller-supplied column has to belong to the bound project. Without this check any
  // positive id was accepted, including one from another (even invisible) project, and
  // every ticket filed into it rendered on no board.
  if (input.intakeColumnId !== undefined && !(await columnBelongsToProject(input.intakeColumnId, input.projectId))) {
    throw new AppError(400, 'invalid_support_config', 'That intake column belongs to a different project');
  }
  const intakeColumnId = input.intakeColumnId ?? (await resolveIntakeColumnId(input.projectId));
  if (intakeColumnId === null) {
    throw new AppError(400, 'invalid_support_config', 'Target project has no columns to file tickets into');
  }
  return { projectId: input.projectId, intakeColumnId, instructions: input.instructions };
}

channelsRouter.post('/', requireUserAuth, /* creating a channel is org structure */ validate(createBody), async (req, res) => {
  const input = req.valid as z.infer<typeof createBody>;
  const isAdmin = req.auth!.role === 'admin';
  const { kind, supportConfig, ...channelInput } = input;

  if (kind === 'support' && !supportConfig) {
    throw new AppError(400, 'invalid_support_config', 'A support channel requires supportConfig');
  }
  // The same silent-discard as the PUT below: a config sent for a standard channel
  // used to be dropped on the floor and answered 201, so the caller believed it had
  // configured triage that would never run.
  if (kind !== 'support' && supportConfig) {
    throw new AppError(400, 'invalid_support_config', 'Only a support channel can have a support config');
  }
  // Authorize the project binding BEFORE creating the channel, so a failed bind
  // never leaves an orphaned support channel with no config behind.
  const binding =
    kind === 'support' && supportConfig
      ? await resolveSupportBinding(supportConfig, req.auth!.userId, isAdmin)
      : null;

  const channel = await createChannel({ ...channelInput, kind, createdBy: req.auth!.userId });
  if (binding) await upsertSupportConfig({ channelId: channel.id, ...binding });
  res.status(201).json({ channel });
});

channelsRouter.get('/:id', requireScope('chat:read'), async (req, res) => {
  const id = parseId(req.params.id);
  const channel = await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  res.json({ channel });
});

const patchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  topic: z.string().max(255).nullable().optional(),
});

channelsRouter.patch('/:id', requireUserAuth, /* renaming/archiving is org structure */ validate(patchBody), async (req, res) => {
  const id = parseId(req.params.id);
  const isAdmin = req.auth!.role === 'admin';
  await requireVisibleChannel(id, req.auth!.userId, isAdmin);
  await requireOwnerOrAdmin(id, req.auth!.userId, isAdmin);
  await db.update(channels).set(req.valid as z.infer<typeof patchBody>).where(eq(channels.id, id));
  const channel = await getVisibleChannel(id, req.auth!.userId, true);
  res.json({ channel });
});

const memberBody = z.object({ userId: z.number().int().positive() });

channelsRouter.post('/:id/members', requireUserAuth, /* membership decides visibility */ validate(memberBody), async (req, res) => {
  const id = parseId(req.params.id);
  const isAdmin = req.auth!.role === 'admin';
  await requireVisibleChannel(id, req.auth!.userId, isAdmin);
  await requireOwnerOrAdmin(id, req.auth!.userId, isAdmin);
  await addChannelMember(id, (req.valid as z.infer<typeof memberBody>).userId);
  res.status(201).json({ ok: true });
});

channelsRouter.delete('/:id/members/:userId', requireUserAuth, /* membership decides visibility */ async (req, res) => {
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

channelsRouter.get('/:id/messages', requireScope('chat:read'), validate(historyQuery, 'query'), async (req, res) => {
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

channelsRouter.post('/:id/messages', requireScope('chat:write'), validate(sendBody), async (req, res) => {
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

channelsRouter.post('/:id/read', requireUserAuth, /* read state belongs to a person */ validate(readBody), async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  await markRead(id, req.auth!.userId, (req.valid as z.infer<typeof readBody>).messageId);
  res.json({ ok: true });
});

channelsRouter.get('/:id/call', requireUserAuth, /* a LiveKit join grant is not for a token */ async (req, res) => {
  const id = parseId(req.params.id);
  await requireVisibleChannel(id, req.auth!.userId, req.auth!.role === 'admin');
  const call = await getActiveCallForChannel(id);
  res.json({ call });
});

channelsRouter.get('/:id/support-config', requireUserAuth, /* a token must not read its own triage config */ async (req, res) => {
  const id = parseId(req.params.id);
  const isAdmin = req.auth!.role === 'admin';
  await requireVisibleChannel(id, req.auth!.userId, isAdmin);
  const supportConfig = await getSupportConfig(id);

  // The config names a project, so returning it to anyone who can see the channel
  // exposed private projects: a public support channel bound to a private project
  // told the whole company that project exists, which is exactly what the create
  // path takes care to prevent. The channel itself is legitimately visible, so
  // this withholds the binding rather than 404-ing the channel.
  if (supportConfig && !(await getVisibleProject(supportConfig.projectId, req.auth!.userId, isAdmin))) {
    res.json({ supportConfig: null });
    return;
  }
  res.json({ supportConfig });
});

const supportConfigPut = z.object({
  projectId: z.number().int().positive(),
  intakeColumnId: z.number().int().positive().optional(),
  instructions: z.string().max(2000).nullable().optional(),
  aiEnabled: z.boolean().optional(),
});

channelsRouter.put('/:id/support-config', requireUserAuth, /* a token editing its own triage config is self-escalation */ validate(supportConfigPut), async (req, res) => {
  const id = parseId(req.params.id);
  const isAdmin = req.auth!.role === 'admin';
  const channel = await requireVisibleChannel(id, req.auth!.userId, isAdmin);
  await requireOwnerOrAdmin(id, req.auth!.userId, isAdmin);
  // Nothing can flip channels.kind after creation, so writing a config row for a
  // standard channel would store a row the intake automation never reads — a 200
  // that silently does nothing.
  if (channel.kind !== 'support') {
    throw new AppError(400, 'invalid_support_config', 'Only a support channel can have a support config');
  }
  const input = req.valid as z.infer<typeof supportConfigPut>;
  const binding = await resolveSupportBinding(
    { projectId: input.projectId, intakeColumnId: input.intakeColumnId },
    req.auth!.userId,
    isAdmin,
  );
  const supportConfig = await upsertSupportConfig({
    channelId: id,
    projectId: binding.projectId,
    intakeColumnId: binding.intakeColumnId,
    aiEnabled: input.aiEnabled,
    instructions: input.instructions ?? null,
  });
  res.json({ supportConfig });
});

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

const editBody = z.object({ body: z.string().min(1).max(4000) });

messagesRouter.patch('/:id', requireScope('chat:write'), validate(editBody), async (req, res) => {
  const id = parseId(req.params.id);
  const ok = await editMessage(id, req.auth!.userId, (req.valid as z.infer<typeof editBody>).body);
  if (!ok) throw new AppError(403, 'forbidden', 'Only the author can edit this message');
  res.json({ ok: true });
});

messagesRouter.delete('/:id', requireScope('chat:write'), async (req, res) => {
  const id = parseId(req.params.id);
  const ok = await softDeleteMessage(id, req.auth!.userId);
  if (!ok) throw new AppError(403, 'forbidden', 'Only the author can delete this message');
  res.json({ ok: true });
});

const reactionBody = z.object({ emoji: z.string().min(1).max(32) });

messagesRouter.put('/:id/reactions', requireUserAuth, /* default-deny; no scope covers reacting */ validate(reactionBody), async (req, res) => {
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

searchRouter.get('/messages', requireScope('chat:read'), validate(searchQuery, 'query'), async (req, res) => {
  const { q, channelId } = req.valid as z.infer<typeof searchQuery>;
  const results = await searchMessages(req.auth!.userId, req.auth!.role === 'admin', q, channelId);
  res.json({ messages: results });
});
