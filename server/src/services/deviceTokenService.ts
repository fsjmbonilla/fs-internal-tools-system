import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { deviceTokens } from '../db/schema/index.js';

export type Platform = 'ios' | 'android' | 'web';

export async function registerDeviceToken(
  userId: number,
  token: string,
  platform: Platform,
): Promise<void> {
  await db
    .insert(deviceTokens)
    .values({ userId, token, platform, lastSeenAt: new Date() })
    .onDuplicateKeyUpdate({ set: { userId, platform, lastSeenAt: new Date() } });
}

export async function unregisterDeviceToken(userId: number, token: string): Promise<void> {
  await db
    .delete(deviceTokens)
    .where(and(eq(deviceTokens.userId, userId), eq(deviceTokens.token, token)));
}

export async function getTokensForUsers(userIds: number[]): Promise<{ token: string }[]> {
  if (userIds.length === 0) return [];
  return db
    .select({ token: deviceTokens.token })
    .from(deviceTokens)
    .where(inArray(deviceTokens.userId, userIds));
}

export async function deleteToken(token: string): Promise<void> {
  await db.delete(deviceTokens).where(eq(deviceTokens.token, token));
}
