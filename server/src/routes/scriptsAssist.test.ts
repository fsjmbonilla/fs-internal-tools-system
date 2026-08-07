/**
 * The script editor's AI assistant — a paid AI call, so what belongs here is
 * invariant 7: the endpoint is invisible to non-admins like the rest of the
 * scripts surface, refuses clearly when no provider is configured, is gated by
 * checkAiBudget(), and books every dispatched call on the ai_usage ledger with
 * its token counts — including calls that failed.
 *
 * The backend is faked at aiService's provider-agnostic facade (completeText /
 * isAiConfigured), the same switch triage rides, so no test needs an API key or
 * a network call — and the assist path provably works with whichever provider
 * AI_PROVIDER selects.
 */

import { isNull } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import { aiUsage } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import type { CompletionInput } from '../services/ai/triage.js';
import { AI_NOT_CONFIGURED } from '../services/scriptAssistService.js';
import { makeUser } from '../testHelpers.js';

// The fake backend behind aiService's facade — configured unless a test says not.
const fake = vi.hoisted(() => ({
  configured: true,
  complete: vi.fn<(input: CompletionInput) => Promise<string>>(),
}));
vi.mock('../services/aiService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiService.js')>();
  return {
    ...actual,
    isAiConfigured: () => fake.configured,
    aiProviderName: () => 'openai',
    completeText: (input: CompletionInput) => fake.complete(input),
  };
});

// Deterministic budget config, so the gate is exercised the way production runs it.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    config: { ...actual.config, AI_MIN_INTERVAL_MS: 60_000, AI_DAILY_CALL_CAP: 500 },
  };
});

const { createApp } = await import('../app.js');
const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` }) as Record<string, string>;

const BODY = { source: 'print("hi")', instruction: 'What does this do?', mode: 'analyze' as const };

/** The provider answers, reporting what the call cost — the real complete() contract. */
function answerWith(text: string, usage = { promptTokens: 111, completionTokens: 42 }) {
  fake.complete.mockImplementation(async (input) => {
    input.onUsage?.({ provider: 'openai', model: 'gpt-4.1-mini', ...usage });
    return text;
  });
}

/** The provider throws — after reporting the dispatched call, as the real one does. */
function failWith(message: string, usage = { promptTokens: 0, completionTokens: 0 }) {
  fake.complete.mockImplementation(async (input) => {
    input.onUsage?.({ provider: 'openai', model: 'gpt-4.1-mini', ...usage });
    throw new Error(message);
  });
}

describe('POST /api/scripts/assist', () => {
  beforeEach(async () => {
    await resetDb();
    fake.configured = true;
    fake.complete.mockReset();
  });

  it('is invisible to non-admins, like the rest of the scripts surface', async () => {
    const member = await makeUser(app, { email: 'sa-member@flowerstore.ph' });
    expect((await request(app).post('/api/scripts/assist').send(BODY)).status).toBe(401);
    // 404 rather than 403: the endpoint's existence is not something to advertise.
    expect(
      (await request(app).post('/api/scripts/assist').set(auth(member.token)).send(BODY)).status,
    ).toBe(404);
  });

  it('rejects a bad body before anything is dispatched', async () => {
    const admin = await makeUser(app, { email: 'sa-400@flowerstore.ph', admin: true });
    answerWith('never');

    const cases = [
      { ...BODY, instruction: undefined }, // missing
      { ...BODY, instruction: '' }, // empty
      { ...BODY, instruction: 'x'.repeat(2001) }, // too long
      { ...BODY, mode: 'rewrite' }, // not a mode
      { ...BODY, source: 'x'.repeat(100_001) }, // over the source cap
    ];
    for (const body of cases) {
      const res = await request(app).post('/api/scripts/assist').set(auth(admin.token)).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
    expect(fake.complete).not.toHaveBeenCalled();
  });

  it('fails clearly when no AI provider is configured', async () => {
    fake.configured = false;
    const admin = await makeUser(app, { email: 'sa-unconf@flowerstore.ph', admin: true });
    const res = await request(app).post('/api/scripts/assist').set(auth(admin.token)).send(BODY);
    expect(res.status).toBe(503);
    expect(res.body.error.message).toBe(AI_NOT_CONFIGURED);
  });

  it('is stopped by the budget gate before the provider is reached', async () => {
    const admin = await makeUser(app, { email: 'sa-budget@flowerstore.ph', admin: true });
    answerWith('never');
    // A channel-less AI call already on the ledger inside the interval window.
    await db
      .insert(aiUsage)
      .values({ channelId: null, provider: 'openai', model: 'm', promptTokens: 1, completionTokens: 1 });

    const res = await request(app).post('/api/scripts/assist').set(auth(admin.token)).send(BODY);
    expect(res.status).toBe(429);
    expect(fake.complete).not.toHaveBeenCalled();
  });

  it('answers, and books the call on the ledger with its real token counts', async () => {
    const admin = await makeUser(app, { email: 'sa-ok@flowerstore.ph', admin: true });
    answerWith('Here you go:\n```python\nprint("revised")\n```\nDone.');

    const res = await request(app)
      .post('/api/scripts/assist')
      .set(auth(admin.token))
      .send({ ...BODY, mode: 'edit', instruction: 'Rename the variable' });
    expect(res.status).toBe(200);
    expect(res.body.reply).toContain('print("revised")');
    expect(res.body.revisedSource).toBe('print("revised")');
    expect(fake.complete).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(aiUsage).where(isNull(aiUsage.channelId));
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('openai');
    expect(rows[0].promptTokens).toBe(111);
    expect(rows[0].completionTokens).toBe(42);
  });

  it('extracts a revised script only in edit mode', async () => {
    const admin = await makeUser(app, { email: 'sa-mode@flowerstore.ph', admin: true });
    answerWith('Analysis with an example:\n```python\nprint("sample")\n```');

    const res = await request(app)
      .post('/api/scripts/assist')
      .set(auth(admin.token))
      .send({ ...BODY, mode: 'analyze' });
    expect(res.status).toBe(200);
    // The fence is illustrative in analyze mode, not a replacement script.
    expect(res.body.revisedSource).toBeNull();
  });

  it('returns null revisedSource when an edit reply was cut off mid-fence', async () => {
    const admin = await makeUser(app, { email: 'sa-cut@flowerstore.ph', admin: true });
    // Truncated by max_tokens: the fence never closes, so it must not be applied.
    answerWith('```python\nprint("half a scri');

    const res = await request(app)
      .post('/api/scripts/assist')
      .set(auth(admin.token))
      .send({ ...BODY, mode: 'edit' });
    expect(res.status).toBe(200);
    expect(res.body.revisedSource).toBeNull();
  });

  it('still books a dispatched call that failed, so a broken provider is not retried hot', async () => {
    const admin = await makeUser(app, { email: 'sa-fail@flowerstore.ph', admin: true });
    failWith('boom from the provider');

    const res = await request(app).post('/api/scripts/assist').set(auth(admin.token)).send(BODY);
    expect(res.status).toBe(502);

    // The attempt is on the ledger with zero tokens — it consumes the interval.
    const rows = await db.select().from(aiUsage).where(isNull(aiUsage.channelId));
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(0);

    // And the very next assist is inside the interval: the gate holds.
    const again = await request(app).post('/api/scripts/assist').set(auth(admin.token)).send(BODY);
    expect(again.status).toBe(429);
  });
});
