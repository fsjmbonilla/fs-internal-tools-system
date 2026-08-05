import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channelMembers, channels, departmentMembers, users } from '../db/schema/index.js';
import { events } from './events.js';

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
  // Their socket is already joined to this channel's room, so removal has to be
  // pushed to it. Otherwise a removed member keeps receiving a private channel's
  // messages in real time until they happen to reconnect.
  events.emit('access.channelRevoked', { channelId, userId });
}

export async function createChannel(input: {
  name: string;
  isPrivate: boolean;
  topic?: string;
  departmentId?: number;
  kind?: 'standard' | 'support';
  createdBy: number;
}): Promise<ChannelRow> {
  const [{ id }] = await db
    .insert(channels)
    .values({
      name: input.name,
      isPrivate: input.isPrivate,
      type: input.isPrivate ? 'private' : 'public',
      kind: input.kind ?? 'standard',
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

  // Channel and both memberships in one transaction. A half-created DM is worse
  // than none at all: the row holds the pair's dm_key, so the lookup above would
  // keep returning a channel that neither person is a member of, and they could
  // never open a working DM again.
  let id: number;
  try {
    id = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(channels)
        .values({ type: 'dm', isPrivate: true, dmKey, createdBy: userIdA })
        .$returningId();
      await tx.insert(channelMembers).values([
        { channelId: inserted.id, userId: userIdA },
        { channelId: inserted.id, userId: userIdB },
      ]);
      return inserted.id;
    });
  } catch (err) {
    // Two people opening the same DM at once: whoever lost the unique dm_key
    // race adopts the winner's channel instead of failing.
    const [raced] = await db.select().from(channels).where(eq(channels.dmKey, dmKey));
    if (raced) return raced;
    throw err;
  }

  const [row] = await db.select().from(channels).where(eq(channels.id, id));
  return row;
}

export interface DmSummary {
  id: number;
  dmKey: string | null;
  /** The person on the other side, or null if their account is gone. */
  user: { id: number; displayName: string; avatarUrl: string | null } | null;
}

/**
 * The user's DMs, each named by the person on the other side.
 *
 * Resolved here rather than in the client: a DM has no name of its own, and the
 * only other clue is `dmKey` ('dm:<lo>:<hi>'). Parsing that in the UI would put
 * the key format — an internal detail of how the pair is deduplicated — into
 * every consumer.
 *
 * Two queries regardless of how many DMs there are.
 */
export async function listMyDms(userId: number): Promise<DmSummary[]> {
  const mine = await db
    .select({ id: channels.id, dmKey: channels.dmKey })
    .from(channels)
    .innerJoin(channelMembers, eq(channelMembers.channelId, channels.id))
    .where(and(eq(channels.type, 'dm'), eq(channelMembers.userId, userId)));
  if (mine.length === 0) return [];

  const others = await db
    .select({
      channelId: channelMembers.channelId,
      id: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(channelMembers)
    .innerJoin(users, eq(users.id, channelMembers.userId))
    .where(
      and(
        inArray(
          channelMembers.channelId,
          mine.map((m) => m.id),
        ),
        ne(channelMembers.userId, userId),
      ),
    );

  const byChannel = new Map(others.map((o) => [o.channelId, o]));
  return mine.map((dm) => {
    const other = byChannel.get(dm.id);
    return {
      id: dm.id,
      dmKey: dm.dmKey,
      user: other
        ? { id: other.id, displayName: other.displayName, avatarUrl: other.avatarUrl }
        : null,
    };
  });
}

export async function getOtherDmMember(channelId: number, excludeUserId: number): Promise<number | null> {
  const [row] = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), sql`${channelMembers.userId} <> ${excludeUserId}`));
  return row?.userId ?? null;
}
