import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { hashPassword } from './passwords.js';

export const BOT_EMAIL = 'assistant@flowerstore.ph';
export const BOT_DISPLAY_NAME = 'FS Assistant';

export async function getBotUserId(): Promise<number | null> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, BOT_EMAIL));
  return row?.id ?? null;
}

export async function ensureBotUser(): Promise<number> {
  const existing = await getBotUserId();
  if (existing !== null) {
    // Repair rather than assume. is_bot is the loop guard that stops the
    // assistant answering itself, and get-or-create left it however it was found
    // — a pre-existing account at this address, or one manual UPDATE, disabled
    // the guard silently.
    await db.update(users).set({ isBot: true, isActive: true }).where(eq(users.id, existing));
    return existing;
  }
  // The bot never logs in; hash a throwaway random secret so no usable password exists.
  const passwordHash = await hashPassword(randomBytes(32).toString('hex'));
  const [{ id }] = await db
    .insert(users)
    .values({ email: BOT_EMAIL, passwordHash, displayName: BOT_DISPLAY_NAME, isBot: true })
    .$returningId();
  return id;
}
