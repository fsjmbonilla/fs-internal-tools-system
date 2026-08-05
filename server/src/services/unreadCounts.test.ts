/**
 * Phase 5 Task C1 — getUnreadCounts is one query now, not one per channel.
 *
 * It runs on every channel-list render, so its cost used to grow with how many
 * channels a person was in. The rewrite has to produce byte-identical output,
 * which is what the reference implementation below is for: it is the original
 * per-membership loop, kept only in this test.
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db/index.js';
import { channelMembers, messages } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { getUnreadCounts } from './messageService.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` } as Record<string, string>);

/** The implementation this replaced: one COUNT(*) per membership. */
async function referenceUnreadCounts(userId: number): Promise<Record<number, number>> {
  const memberships = await db
    .select()
    .from(channelMembers)
    .where(eq(channelMembers.userId, userId));
  const result: Record<number, number> = {};
  for (const m of memberships) {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, m.channelId),
          gt(messages.id, m.lastReadMessageId),
          isNull(messages.deletedAt),
        ),
      );
    result[m.channelId] = Number(row.count);
  }
  return result;
}

describe('getUnreadCounts', () => {
  beforeEach(resetDb);

  async function scenario() {
    const me = await makeUser(app, { email: `me${Date.now()}@flowerstore.ph` });
    const other = await makeUser(app, { email: `ot${Date.now()}@flowerstore.ph` });

    // Three channels: unread messages, all-read, and empty.
    const ids: number[] = [];
    for (const name of ['alpha', 'beta', 'gamma']) {
      const res = await request(app)
        .post('/api/channels')
        .set(auth(me.token))
        .send({ name: `${name}${Date.now()}`, isPrivate: false });
      ids.push(res.body.channel.id);
    }
    const [withUnread, allRead, empty] = ids;

    // Someone else posts, so these count as unread for me.
    await request(app).post(`/api/channels/${withUnread}/members`).set(auth(me.token)).send({ userId: other.userId });
    for (const body of ['one', 'two', 'three']) {
      await request(app).post(`/api/channels/${withUnread}/messages`).set(auth(other.token)).send({ body });
    }

    // A channel where everything has been read.
    await request(app).post(`/api/channels/${allRead}/members`).set(auth(me.token)).send({ userId: other.userId });
    const posted = await request(app)
      .post(`/api/channels/${allRead}/messages`)
      .set(auth(other.token))
      .send({ body: 'seen' });
    await request(app)
      .post(`/api/channels/${allRead}/read`)
      .set(auth(me.token))
      .send({ messageId: posted.body.message.id });

    return { me, other, withUnread, allRead, empty };
  }

  it('matches the per-channel implementation it replaced', async () => {
    const s = await scenario();
    const [fast, reference] = await Promise.all([
      getUnreadCounts(s.me.userId),
      referenceUnreadCounts(s.me.userId),
    ]);
    expect(fast).toEqual(reference);
  });

  it('counts unread, reports zero for read, and keeps empty channels in the result', async () => {
    const s = await scenario();
    const counts = await getUnreadCounts(s.me.userId);

    expect(counts[s.withUnread]).toBe(3);
    expect(counts[s.allRead]).toBe(0);
    // A channel with nothing in it must still appear, or the sidebar loses it.
    expect(counts[s.empty]).toBe(0);
  });

  it('ignores soft-deleted messages', async () => {
    const s = await scenario();
    const posted = await request(app)
      .post(`/api/channels/${s.withUnread}/messages`)
      .set(auth(s.other.token))
      .send({ body: 'will be deleted' });
    expect((await getUnreadCounts(s.me.userId))[s.withUnread]).toBe(4);

    await request(app).delete(`/api/messages/${posted.body.message.id}`).set(auth(s.other.token));

    expect((await getUnreadCounts(s.me.userId))[s.withUnread]).toBe(3);
    expect(await getUnreadCounts(s.me.userId)).toEqual(await referenceUnreadCounts(s.me.userId));
  });

  it('returns nothing for someone with no memberships', async () => {
    const loner = await makeUser(app, { email: `lone${Date.now()}@flowerstore.ph` });
    expect(await getUnreadCounts(loner.userId)).toEqual({});
  });

  it('is served on the channel list', async () => {
    const s = await scenario();
    const res = await request(app).get('/api/channels').set(auth(s.me.token));
    const channel = res.body.channels.find((c: { id: number }) => c.id === s.withUnread);
    expect(channel.unreadCount).toBe(3);
  });
});
