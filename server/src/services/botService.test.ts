import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { BOT_DISPLAY_NAME, BOT_EMAIL, ensureBotUser, getBotUserId } from './botService.js';

describe('botService', () => {
  beforeEach(resetDb);

  it('getBotUserId returns null before the bot is seeded', async () => {
    expect(await getBotUserId()).toBeNull();
  });

  it('ensureBotUser creates the bot with is_bot set, and is idempotent', async () => {
    const first = await ensureBotUser();
    const second = await ensureBotUser();
    expect(second).toBe(first);

    const rows = await db.select().from(users).where(eq(users.email, BOT_EMAIL));
    expect(rows).toHaveLength(1);
    expect(rows[0].isBot).toBe(true);
    expect(rows[0].displayName).toBe(BOT_DISPLAY_NAME);
    expect(rows[0].isActive).toBe(true);
  });

  it('getBotUserId finds the bot once seeded', async () => {
    const id = await ensureBotUser();
    expect(await getBotUserId()).toBe(id);
  });
});
