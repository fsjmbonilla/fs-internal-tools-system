/**
 * Creating a support channel is one transaction.
 *
 * The binding is authorized before anything is written, so the common failure was
 * already covered — but the config upsert can still fail on its own, and a channel
 * whose `kind` says 'support' with no config row is inert in a way nothing
 * surfaces: intake logs "no support config" and silently does nothing, while the
 * channel looks perfectly normal in the sidebar.
 *
 * Its own file because it mocks the config upsert to fail, which the other support
 * suites need working.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import { channels, supportConfigs } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const upsertShouldFail = vi.hoisted(() => ({ value: false }));

vi.mock('../services/supportConfigService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/supportConfigService.js')>();
  return {
    ...actual,
    upsertSupportConfig: vi.fn(async (...args: Parameters<typeof actual.upsertSupportConfig>) => {
      if (upsertShouldFail.value) throw new Error('simulated upsert failure');
      return actual.upsertSupportConfig(...args);
    }),
  };
});

const { createApp } = await import('../app.js');
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` } as Record<string, string>);

async function makeProject(token: string, name: string) {
  const project = await request(app).post('/api/projects').set(auth(token)).send({ name, isPrivate: false });
  return project.body.project.id as number;
}

describe('creating a support channel is atomic', () => {
  beforeEach(async () => {
    await resetDb();
    upsertShouldFail.value = false;
  });

  it('leaves no channel behind when the config write fails', async () => {
    const owner = await makeUser(app, { email: 'atomic@flowerstore.ph' });
    const projectId = await makeProject(owner.token, 'Atomic project');

    upsertShouldFail.value = true;
    const res = await request(app)
      .post('/api/channels')
      .set(auth(owner.token))
      .send({ name: `atomic${Date.now()}`, isPrivate: false, kind: 'support', supportConfig: { projectId } });

    expect(res.status).toBe(500);
    // The whole thing rolled back: no orphaned channel, no membership, no config.
    expect(await db.select().from(channels)).toHaveLength(0);
    expect(await db.select().from(supportConfigs)).toHaveLength(0);
  });

  it('commits both rows when the config write succeeds', async () => {
    const owner = await makeUser(app, { email: 'atomic2@flowerstore.ph' });
    const projectId = await makeProject(owner.token, 'Atomic project 2');

    const res = await request(app)
      .post('/api/channels')
      .set(auth(owner.token))
      .send({ name: `atomic${Date.now()}`, isPrivate: false, kind: 'support', supportConfig: { projectId } });

    expect(res.status).toBe(201);
    expect(await db.select().from(channels)).toHaveLength(1);
    expect(await db.select().from(supportConfigs)).toHaveLength(1);
  });
});
