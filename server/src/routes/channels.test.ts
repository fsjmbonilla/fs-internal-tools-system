import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('channel routes', () => {
  beforeEach(resetDb);

  it('creates a channel, lists it, and 404s a private one for outsiders', async () => {
    const owner = await makeUser(app, { email: 'owner@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'outsider@flowerstore.ph' });

    const create = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'secret', isPrivate: true });
    expect(create.status).toBe(201);
    const channelId = create.body.channel.id;

    expect(
      (await request(app).get(`/api/channels/${channelId}`).set('Authorization', `Bearer ${outsider.token}`))
        .status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/channels/${channelId}`).set('Authorization', `Bearer ${owner.token}`)).status,
    ).toBe(200);
    expect(
      (await request(app).get('/api/channels').set('Authorization', `Bearer ${outsider.token}`)).body.channels,
    ).toHaveLength(0);
  });

  it('sends via REST, paginates, tracks unread', async () => {
    const owner = await makeUser(app, { email: 'owner2@flowerstore.ph' });
    const reader = await makeUser(app, { email: 'reader@flowerstore.ph' });
    const create = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'g', isPrivate: false });
    const channelId = create.body.channel.id;
    await request(app)
      .post(`/api/channels/${channelId}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: reader.userId });

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/api/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ body: `msg ${i}` })
        .expect(201);
    }

    const history = await request(app)
      .get(`/api/channels/${channelId}/messages?limit=2`)
      .set('Authorization', `Bearer ${reader.token}`);
    expect(history.status).toBe(200);
    expect(history.body.messages).toHaveLength(2);

    const list = await request(app).get('/api/channels').set('Authorization', `Bearer ${reader.token}`);
    const entry = list.body.channels.find((c: { id: number }) => c.id === channelId);
    expect(entry.unreadCount).toBe(3);

    const lastId = history.body.messages[0].id;
    await request(app)
      .post(`/api/channels/${channelId}/read`)
      .set('Authorization', `Bearer ${reader.token}`)
      .send({ messageId: lastId })
      .expect(200);
  });

  it('reactions toggle and search is visibility-filtered', async () => {
    const owner = await makeUser(app, { email: 'owner3@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'outsider3@flowerstore.ph' });
    const pub = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'pub', isPrivate: false });
    const priv = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'priv', isPrivate: true });

    const msg = await request(app)
      .post(`/api/channels/${pub.body.channel.id}/messages`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ body: 'unique-search-token here' });

    await request(app)
      .put(`/api/messages/${msg.body.message.id}/reactions`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ emoji: '🎉' })
      .expect(200);

    await request(app)
      .post(`/api/channels/${priv.body.channel.id}/messages`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ body: 'unique-search-token secret' });

    const results = await request(app)
      .get('/api/search/messages?q=unique-search-token')
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(results.body.messages).toHaveLength(1);
    expect(results.body.messages[0].reactions).toEqual([{ emoji: '🎉', userIds: [owner.userId] }]);
  });

  it('rejects a non-numeric channel id with 400 once authenticated', async () => {
    const owner = await makeUser(app, { email: 'owner5@flowerstore.ph' });
    const res = await request(app)
      .get('/api/channels/not-a-number/messages')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('edit/delete a message are author-only (403 for others)', async () => {
    const owner = await makeUser(app, { email: 'owner4@flowerstore.ph' });
    const other = await makeUser(app, { email: 'other4@flowerstore.ph' });
    const chan = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'g4', isPrivate: false });
    const msg = await request(app)
      .post(`/api/channels/${chan.body.channel.id}/messages`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ body: 'original' });

    expect(
      (
        await request(app)
          .patch(`/api/messages/${msg.body.message.id}`)
          .set('Authorization', `Bearer ${other.token}`)
          .send({ body: 'hacked' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/api/messages/${msg.body.message.id}`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ body: 'edited' })
      ).status,
    ).toBe(200);
  });
});
