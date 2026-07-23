import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, channelMembers, channels, messageReactions, messages, users } from '../db/schema/index.js';
import { AppError } from '../middleware/errorHandler.js';
import { linkAttachment } from './attachmentService.js';
import { visibilityCondition } from './channelService.js';
import { events } from './events.js';

export interface AttachmentInfo {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface MessageWithAuthor {
  id: number;
  channelId: number;
  userId: number;
  displayName: string;
  body: string;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  reactions: { emoji: string; userIds: number[] }[];
  attachments: AttachmentInfo[];
}

type RawMessageRow = {
  id: number;
  channelId: number;
  userId: number;
  body: string;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  displayName: string;
};

const messageSelection = {
  id: messages.id,
  channelId: messages.channelId,
  userId: messages.userId,
  body: messages.body,
  editedAt: messages.editedAt,
  deletedAt: messages.deletedAt,
  createdAt: messages.createdAt,
  displayName: users.displayName,
};

async function hydrateReactions(
  messageIds: number[],
): Promise<Map<number, { emoji: string; userIds: number[] }[]>> {
  const map = new Map<number, { emoji: string; userIds: number[] }[]>();
  if (messageIds.length === 0) return map;
  const rows = await db
    .select()
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds));
  for (const r of rows) {
    const list = map.get(r.messageId) ?? [];
    const existing = list.find((x) => x.emoji === r.emoji);
    if (existing) existing.userIds.push(r.userId);
    else list.push({ emoji: r.emoji, userIds: [r.userId] });
    map.set(r.messageId, list);
  }
  return map;
}

async function hydrateAttachments(messageIds: number[]): Promise<Map<number, AttachmentInfo[]>> {
  const map = new Map<number, AttachmentInfo[]>();
  if (messageIds.length === 0) return map;
  const rows = await db.select().from(attachments).where(inArray(attachments.messageId, messageIds));
  for (const r of rows) {
    const list = map.get(r.messageId!) ?? [];
    list.push({ id: r.id, fileName: r.fileName, mimeType: r.mimeType, sizeBytes: r.sizeBytes });
    map.set(r.messageId!, list);
  }
  return map;
}

function toDto(
  row: RawMessageRow,
  reactions: Map<number, { emoji: string; userIds: number[] }[]>,
  attachmentsByMessage: Map<number, AttachmentInfo[]>,
): MessageWithAuthor {
  return {
    id: row.id,
    channelId: row.channelId,
    userId: row.userId,
    displayName: row.displayName,
    body: row.body,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    reactions: reactions.get(row.id) ?? [],
    attachments: attachmentsByMessage.get(row.id) ?? [],
  };
}

export async function sendMessage(
  channelId: number,
  userId: number,
  body: string,
  attachmentIds?: number[],
): Promise<MessageWithAuthor> {
  const [{ id }] = await db.insert(messages).values({ channelId, userId, body }).$returningId();
  for (const attachmentId of attachmentIds ?? []) {
    const ok = await linkAttachment(attachmentId, userId, { messageId: id });
    if (!ok) throw new AppError(400, 'invalid_attachment', `Attachment ${attachmentId} could not be linked`);
  }
  const [row] = await db
    .select(messageSelection)
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(eq(messages.id, id));
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
  events.emit('message.created', {
    message: { id: row.id, channelId, userId, body },
    channel: { id: channel.id, isPrivate: channel.isPrivate },
  });
  const attachmentsByMessage = await hydrateAttachments([id]);
  return toDto(row, new Map(), attachmentsByMessage);
}

export async function getMessagesBefore(
  channelId: number,
  beforeId: number | null,
  limit: number,
): Promise<MessageWithAuthor[]> {
  const conditions = [eq(messages.channelId, channelId), isNull(messages.deletedAt)];
  if (beforeId !== null) conditions.push(lt(messages.id, beforeId));
  const rows = await db
    .select(messageSelection)
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(and(...conditions))
    .orderBy(desc(messages.id))
    .limit(limit);
  const reactions = await hydrateReactions(rows.map((r) => r.id));
  const attachmentsByMessage = await hydrateAttachments(rows.map((r) => r.id));
  return rows.map((r) => toDto(r, reactions, attachmentsByMessage));
}

export async function markRead(channelId: number, userId: number, messageId: number): Promise<void> {
  await db
    .update(channelMembers)
    .set({ lastReadMessageId: messageId })
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
}

export async function getUnreadCounts(userId: number): Promise<Record<number, number>> {
  const memberships = await db.select().from(channelMembers).where(eq(channelMembers.userId, userId));
  const result: Record<number, number> = {};
  for (const m of memberships) {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, m.channelId),
          gt(messages.id, m.lastReadMessageId),
          isNull(messages.deletedAt),
        ),
      );
    result[m.channelId] = Number(row.count);
  }
  return result;
}

export async function toggleReaction(
  messageId: number,
  userId: number,
  emoji: string,
): Promise<{ added: boolean }> {
  const existingWhere = and(
    eq(messageReactions.messageId, messageId),
    eq(messageReactions.userId, userId),
    eq(messageReactions.emoji, emoji),
  );
  const [existing] = await db.select().from(messageReactions).where(existingWhere);
  if (existing) {
    await db.delete(messageReactions).where(existingWhere);
    return { added: false };
  }
  await db.insert(messageReactions).values({ messageId, userId, emoji });
  return { added: true };
}

export async function editMessage(messageId: number, userId: number, body: string): Promise<boolean> {
  const [row] = await db.select({ userId: messages.userId }).from(messages).where(eq(messages.id, messageId));
  if (!row || row.userId !== userId) return false;
  await db.update(messages).set({ body, editedAt: new Date() }).where(eq(messages.id, messageId));
  return true;
}

export async function softDeleteMessage(messageId: number, userId: number): Promise<boolean> {
  const [row] = await db.select({ userId: messages.userId }).from(messages).where(eq(messages.id, messageId));
  if (!row || row.userId !== userId) return false;
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, messageId));
  return true;
}

export async function searchMessages(
  userId: number,
  isAdmin: boolean,
  query: string,
  channelId?: number,
): Promise<MessageWithAuthor[]> {
  const visWhere = isAdmin ? sql`1=1` : visibilityCondition(userId);
  const conditions = [
    sql`MATCH(${messages.body}) AGAINST(${query} IN NATURAL LANGUAGE MODE)`,
    isNull(messages.deletedAt),
    sql`messages.channel_id IN (SELECT channels.id FROM channels WHERE ${visWhere})`,
  ];
  if (channelId !== undefined) conditions.push(eq(messages.channelId, channelId));
  const rows = await db
    .select(messageSelection)
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(50);
  const reactions = await hydrateReactions(rows.map((r) => r.id));
  const attachmentsByMessage = await hydrateAttachments(rows.map((r) => r.id));
  return rows.map((r) => toDto(r, reactions, attachmentsByMessage));
}
