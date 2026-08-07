/**
 * The summary's "not configured" path — a separate file because the main
 * dashboard suite pins a configured provider into its config mock, and a
 * module mock cannot vary within one file.
 *
 * The 503 must only fire when NO provider at all is configured; with any
 * key present the summary runs on whichever provider AI_PROVIDER selects.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    config: { ...actual.config, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
  };
});

import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` }) as Record<string, string>;

beforeEach(async () => {
  await resetDb();
});

describe('POST /api/dashboard/summary (no AI provider configured)', () => {
  it('answers 503 ai_unconfigured before touching budget or Google', async () => {
    const me = await makeUser(app);
    const res = await request(app).post('/api/dashboard/summary').set(auth(me.token)).send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ai_unconfigured');
    expect(res.body.error.message).toMatch(/No AI provider is configured/);
  });
});
