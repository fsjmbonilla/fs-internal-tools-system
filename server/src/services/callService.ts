import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { calls } from '../db/schema/index.js';

export type CallRow = typeof calls.$inferSelect;

export async function getActiveCallForChannel(channelId: number): Promise<CallRow | null> {
  const [row] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.channelId, channelId), isNull(calls.endedAt)))
    .orderBy(desc(calls.id))
    .limit(1);
  return row ?? null;
}

export async function startCall(channelId: number | null, userId: number): Promise<CallRow> {
  if (channelId !== null) {
    const existing = await getActiveCallForChannel(channelId);
    if (existing) return existing;
  }

  const roomName =
    channelId !== null ? `channel-${channelId}-${randomUUID().slice(0, 8)}` : `adhoc-${randomUUID()}`;

  const values: { channelId?: number; roomName: string; startedBy: number } = {
    roomName,
    startedBy: userId,
  };
  if (channelId !== null) values.channelId = channelId;

  const [{ id }] = await db.insert(calls).values(values).$returningId();
  const [row] = await db.select().from(calls).where(eq(calls.id, id));
  return row;
}

export async function endCall(callId: number): Promise<CallRow | null> {
  const [row] = await db.select().from(calls).where(eq(calls.id, callId));
  if (!row || row.endedAt !== null) return null;
  await db.update(calls).set({ endedAt: new Date() }).where(eq(calls.id, callId));
  const [updated] = await db.select().from(calls).where(eq(calls.id, callId));
  return updated;
}

export async function getCallById(callId: number): Promise<CallRow | null> {
  const [row] = await db.select().from(calls).where(eq(calls.id, callId));
  return row ?? null;
}
