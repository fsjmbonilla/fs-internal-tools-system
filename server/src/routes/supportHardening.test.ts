/**
 * Phase 7 "Important" fixes — the ones that were the same class of problem as the
 * two criticals: a privacy leak, an infinite-loop guard that could silently
 * switch itself off, and an overlapping-triage runaway.
 */

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { BOT_EMAIL, ensureBotUser, getBotUserId } from '../services/botService.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` } as Record<string, string>);

describe('support-config does not leak a private project', () => {
  beforeEach(resetDb);

  it('withholds the binding from someone who cannot see the project', async () => {
    const owner = await makeUser(app, { email: 'sowner@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'soutsider@flowerstore.ph' });

    // A PRIVATE project…
    const project = await request(app)
      .post('/api/projects')
      .set(auth(owner.token))
      .send({ name: 'Secret Initiative', isPrivate: true });
    const board = await request(app)
      .get(`/api/projects/${project.body.project.id}/board`)
      .set(auth(owner.token));

    // …bound to a PUBLIC support channel.
    const channel = await request(app)
      .post('/api/channels')
      .set(auth(owner.token))
      .send({
        name: `support${Date.now()}`,
        isPrivate: false,
        kind: 'support',
        supportConfig: {
          projectId: project.body.project.id,
          intakeColumnId: board.body.columns[0].id,
        },
      });
    expect(channel.status).toBe(201);
    const channelId = channel.body.channel.id;

    // The owner sees the binding.
    const asOwner = await request(app)
      .get(`/api/channels/${channelId}/support-config`)
      .set(auth(owner.token));
    expect(asOwner.body.supportConfig?.projectId).toBe(project.body.project.id);

    // The outsider can see the channel — it is public — but must not learn that
    // the private project exists, which naming it in the response would do.
    const asOutsider = await request(app)
      .get(`/api/channels/${channelId}/support-config`)
      .set(auth(outsider.token));
    expect(asOutsider.status).toBe(200); // the channel is genuinely visible
    expect(asOutsider.body.supportConfig).toBeNull();
  });
});

describe('the bot loop guard repairs itself', () => {
  beforeEach(resetDb);

  it('forces is_bot back on for a pre-existing account', async () => {
    // is_bot is what stops the assistant answering its own messages forever. A
    // get-or-create left it however it was found, so one manual UPDATE — or an
    // account that already existed at that address — disabled the only guard.
    const id = await ensureBotUser();
    await db.update(users).set({ isBot: false }).where(eq(users.id, id));

    const again = await ensureBotUser();

    expect(again).toBe(id); // still the same account, not a duplicate
    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row.isBot).toBe(true);
    expect(row.email).toBe(BOT_EMAIL);
  });

  it('is idempotent', async () => {
    const first = await ensureBotUser();
    const second = await ensureBotUser();
    expect(second).toBe(first);
    expect(await getBotUserId()).toBe(first);
  });
});
