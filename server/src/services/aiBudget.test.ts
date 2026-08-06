/**
 * The AI spend ceiling — the limiter itself, at the service level.
 *
 * The automation-level proof (that a second message really does not reach the
 * provider) lives in `automations/aiSpendCeiling.test.ts`.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import { aiUsage, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { createChannel } from './channelService.js';

// A tight interval and a cap of 2, so the limits are reachable in a test.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { config: { ...actual.config, AI_MIN_INTERVAL_MS: 60_000, AI_DAILY_CALL_CAP: 2 } };
});

const { channelAiCallCount, checkAiBudget, recordAiUsage, todaysAiCallCount } = await import(
  './aiBudgetService.js'
);

async function seedChannel(name: string) {
  const [{ id: userId }] = await db
    .insert(users)
    .values({ email: `${name}@flowerstore.ph`, passwordHash: 'x', displayName: name })
    .$returningId();
  return createChannel({ name, isPrivate: false, createdBy: userId });
}

const usage = { provider: 'openai', model: 'gpt-4.1-mini', promptTokens: 900, completionTokens: 40 };

describe('the AI spend ceiling', () => {
  beforeEach(resetDb);

  it('allows the first triage on a quiet channel', async () => {
    const channel = await seedChannel('quiet');
    expect(await checkAiBudget(channel.id)).toEqual({ ok: true });
  });

  it('blocks a second triage on the same channel inside the interval', async () => {
    const channel = await seedChannel('busy');
    await recordAiUsage(channel.id, usage);

    expect(await checkAiBudget(channel.id)).toEqual({ ok: false, reason: 'interval' });
  });

  it('allows it again once the interval has passed', async () => {
    const channel = await seedChannel('patient');
    await recordAiUsage(channel.id, usage);

    // Age the row by two minutes rather than sleeping through the interval. The
    // ageing is done in SQL for the same reason the check is: a JS Date written
    // into a MySQL TIMESTAMP does not round-trip cleanly off UTC.
    await db.update(aiUsage).set({ createdAt: sql`NOW() - INTERVAL 2 MINUTE` });

    expect(await checkAiBudget(channel.id)).toEqual({ ok: true });
  });

  it('throttles per channel, so one busy channel does not silence another', async () => {
    const busy = await seedChannel('loud');
    const other = await seedChannel('other');
    await recordAiUsage(busy.id, usage);

    expect(await checkAiBudget(busy.id)).toEqual({ ok: false, reason: 'interval' });
    expect(await checkAiBudget(other.id)).toEqual({ ok: true });
  });

  it('blocks every channel once the daily cap is reached', async () => {
    const a = await seedChannel('capa');
    const b = await seedChannel('capb');
    const c = await seedChannel('capc');
    await recordAiUsage(a.id, usage);
    await recordAiUsage(b.id, usage); // cap is 2

    // c has never been triaged, so the interval does not apply — the cap does.
    expect(await checkAiBudget(c.id)).toEqual({ ok: false, reason: 'daily_cap' });
  });

  it('records the token counts, so spend is auditable rather than inferred', async () => {
    const channel = await seedChannel('audited');
    await recordAiUsage(channel.id, usage);

    const [row] = await db.select().from(aiUsage);
    expect(row.channelId).toBe(channel.id);
    expect(row.provider).toBe('openai');
    expect(row.model).toBe('gpt-4.1-mini');
    expect(row.promptTokens).toBe(900);
    expect(row.completionTokens).toBe(40);
  });

  it('counts calls per day and per channel', async () => {
    const a = await seedChannel('counta');
    const b = await seedChannel('countb');
    await recordAiUsage(a.id, usage);
    await recordAiUsage(b.id, usage);

    expect(await todaysAiCallCount()).toBe(2);
    expect(await channelAiCallCount(a.id)).toBe(1);
  });
});
