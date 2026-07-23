import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channelMembers, channels, departmentMembers } from '../db/schema/index.js';

export type ChannelRow = typeof channels.$inferSelect;

/** Public OR member OR belongs to the owning department. Admins bypass at the call site. */
export function visibilityCondition(userId: number) {
  return or(
    eq(channels.isPrivate, false),
    sql`EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = channels.id AND cm.user_id = ${userId})`,
    and(
      sql`channels.department_id IS NOT NULL`,
      sql`EXISTS (SELECT 1 FROM department_members dm WHERE dm.department_id = channels.department_id AND dm.user_id = ${userId})`,
    ),
  );
}

export async function listVisibleChannels(userId: number, isAdmin: boolean) {
  const notDm = sql`channels.type <> 'dm'`;
  const where = isAdmin ? notDm : and(notDm, visibilityCondition(userId));
  return db.select().from(channels).where(where).orderBy(channels.name);
}

export async function getVisibleChannel(
  channelId: number,
  userId: number,
  isAdmin: boolean,
): Promise<ChannelRow | null> {
  const where = isAdmin
    ? eq(channels.id, channelId)
    : and(eq(channels.id, channelId), visibilityCondition(userId));
  const [row] = await db.select().from(channels).where(where);
  return row ?? null;
}

export async function isChannelMember(channelId: number, userId: number): Promise<boolean> {
  const [row] = await db
    .select()
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
  return Boolean(row);
}

export async function addChannelMember(
  channelId: number,
  userId: number,
  role: 'owner' | 'member' = 'member',
): Promise<void> {
  await db
    .insert(channelMembers)
    .values({ channelId, userId, role })
    .onDuplicateKeyUpdate({ set: { role: sql`role` } }); // insert-or-ignore
}

export async function removeChannelMember(channelId: number, userId: number): Promise<void> {
  await db
    .delete(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
}

export async function createChannel(input: {
  name: string;
  isPrivate: boolean;
  topic?: string;
  departmentId?: number;
  createdBy: number;
}): Promise<ChannelRow> {
  const [{ id }] = await db
    .insert(channels)
    .values({
      name: input.name,
      isPrivate: input.isPrivate,
      type: input.isPrivate ? 'private' : 'public',
      topic: input.topic,
      departmentId: input.departmentId,
      createdBy: input.createdBy,
    })
    .$returningId();
  await addChannelMember(id, input.createdBy, 'owner');
  if (input.departmentId) {
    const members = await db
      .select({ userId: departmentMembers.userId })
      .from(departmentMembers)
      .where(eq(departmentMembers.departmentId, input.departmentId));
    for (const m of members) await addChannelMember(id, m.userId);
  }
  const [row] = await db.select().from(channels).where(eq(channels.id, id));
  return row;
}

export async function findOrCreateDm(userIdA: number, userIdB: number): Promise<ChannelRow> {
  const [lo, hi] = [userIdA, userIdB].sort((a, b) => a - b);
  const dmKey = `dm:${lo}:${hi}`;
  const [existing] = await db.select().from(channels).where(eq(channels.dmKey, dmKey));
  if (existing) return existing;
  const [{ id }] = await db
    .insert(channels)
    .values({ type: 'dm', isPrivate: true, dmKey, createdBy: userIdA })
    .$returningId();
  await addChannelMember(id, userIdA);
  await addChannelMember(id, userIdB);
  const [row] = await db.select().from(channels).where(eq(channels.id, id));
  return row;
}

export async function listMyDms(userId: number) {
  return db
    .select({ id: channels.id, dmKey: channels.dmKey })
    .from(channels)
    .innerJoin(channelMembers, eq(channelMembers.channelId, channels.id))
    .where(and(eq(channels.type, 'dm'), eq(channelMembers.userId, userId)));
}
