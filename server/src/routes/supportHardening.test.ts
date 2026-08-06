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

describe('the intake column has to belong to the bound project', () => {
  beforeEach(resetDb);

  // A column from another project was accepted, so tickets got projectId A with a
  // column of project B. getBoard filters by projectId, so they rendered on no
  // board at all — AI tickets that silently vanished.
  it('rejects a column from a different project', async () => {
    const owner = await makeUser(app, { email: 'colowner@flowerstore.ph' });

    const target = await request(app)
      .post('/api/projects')
      .set(auth(owner.token))
      .send({ name: 'Support target', isPrivate: false });
    const other = await request(app)
      .post('/api/projects')
      .set(auth(owner.token))
      .send({ name: 'Somewhere else', isPrivate: false });
    const otherBoard = await request(app)
      .get(`/api/projects/${other.body.project.id}/board`)
      .set(auth(owner.token));

    const res = await request(app)
      .post('/api/channels')
      .set(auth(owner.token))
      .send({
        name: `crossproj${Date.now()}`,
        isPrivate: false,
        kind: 'support',
        supportConfig: {
          projectId: target.body.project.id,
          intakeColumnId: otherBoard.body.columns[0].id, // belongs to `other`
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_support_config');
  });

  it('still accepts a column that does belong to the project', async () => {
    const owner = await makeUser(app, { email: 'colowner2@flowerstore.ph' });
    const project = await request(app)
      .post('/api/projects')
      .set(auth(owner.token))
      .send({ name: 'Right project', isPrivate: false });
    const board = await request(app)
      .get(`/api/projects/${project.body.project.id}/board`)
      .set(auth(owner.token));

    const res = await request(app)
      .post('/api/channels')
      .set(auth(owner.token))
      .send({
        name: `sameproj${Date.now()}`,
        isPrivate: false,
        kind: 'support',
        supportConfig: {
          projectId: project.body.project.id,
          intakeColumnId: board.body.columns[0].id,
        },
      });

    expect(res.status).toBe(201);
  });
});

describe('support config cannot be attached to a standard channel', () => {
  beforeEach(resetDb);

  // Nothing can flip channels.kind after creation, so the row this used to write
  // was permanently inert: a 200 that changed nothing an automation would ever read.
  it('rejects the PUT and writes nothing', async () => {
    const owner = await makeUser(app, { email: 'putowner@flowerstore.ph' });
    const project = await request(app)
      .post('/api/projects')
      .set(auth(owner.token))
      .send({ name: 'Inert PUT project', isPrivate: false });
    const channel = await request(app)
      .post('/api/channels')
      .set(auth(owner.token))
      .send({ name: `standard${Date.now()}`, isPrivate: false }); // kind defaults to standard
    expect(channel.status).toBe(201);

    const res = await request(app)
      .put(`/api/channels/${channel.body.channel.id}/support-config`)
      .set(auth(owner.token))
      .send({ projectId: project.body.project.id });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_support_config');

    const after = await request(app)
      .get(`/api/channels/${channel.body.channel.id}/support-config`)
      .set(auth(owner.token));
    expect(after.body.supportConfig).toBeNull();
  });

  it('rejects a config sent when creating a standard channel, rather than dropping it', async () => {
    const owner = await makeUser(app, { email: 'discard@flowerstore.ph' });
    const project = await request(app)
      .post('/api/projects')
      .set(auth(owner.token))
      .send({ name: 'Discarded config', isPrivate: false });
    const board = await request(app)
      .get(`/api/projects/${project.body.project.id}/board`)
      .set(auth(owner.token));

    const res = await request(app)
      .post('/api/channels')
      .set(auth(owner.token))
      .send({
        name: `discard${Date.now()}`,
        isPrivate: false,
        // no kind — so this is a standard channel, and the config below would
        // previously have been silently discarded behind a 201.
        supportConfig: {
          projectId: project.body.project.id,
          intakeColumnId: board.body.columns[0].id,
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_support_config');
  });

  it('still updates a real support channel', async () => {
    const owner = await makeUser(app, { email: 'putowner2@flowerstore.ph' });
    const project = await request(app)
      .post('/api/projects')
      .set(auth(owner.token))
      .send({ name: 'Live support project', isPrivate: false });
    const board = await request(app)
      .get(`/api/projects/${project.body.project.id}/board`)
      .set(auth(owner.token));
    const channel = await request(app)
      .post('/api/channels')
      .set(auth(owner.token))
      .send({
        name: `realsupport${Date.now()}`,
        isPrivate: false,
        kind: 'support',
        supportConfig: {
          projectId: project.body.project.id,
          intakeColumnId: board.body.columns[0].id,
        },
      });

    const res = await request(app)
      .put(`/api/channels/${channel.body.channel.id}/support-config`)
      .set(auth(owner.token))
      .send({ projectId: project.body.project.id, instructions: 'Escalate anything about payroll.' });

    expect(res.status).toBe(200);
    expect(res.body.supportConfig.instructions).toBe('Escalate anything about payroll.');
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
