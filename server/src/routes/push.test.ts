import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { getTokensForUsers } from '../services/deviceTokenService.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('push routes', () => {
  beforeEach(resetDb);

  it('registers a device token for the authenticated user', async () => {
    const u = await makeUser(app, { email: 'u@flowerstore.ph' });
    const res = await request(app)
      .post('/api/push/tokens')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ token: 'a-real-looking-token', platform: 'android' });
    expect(res.status).toBe(201);
    expect(await getTokensForUsers([u.userId])).toEqual([{ token: 'a-real-looking-token' }]);
  });

  it('rejects an unknown platform value', async () => {
    const u = await makeUser(app, { email: 'u2@flowerstore.ph' });
    const res = await request(app)
      .post('/api/push/tokens')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ token: 'tok', platform: 'windows-phone' });
    expect(res.status).toBe(400);
  });

  it('removes only the caller-owned token', async () => {
    const owner = await makeUser(app, { email: 'owner@flowerstore.ph' });
    const other = await makeUser(app, { email: 'other@flowerstore.ph' });
    await request(app)
      .post('/api/push/tokens')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ token: 'owned-token', platform: 'ios' });

    await request(app)
      .delete('/api/push/tokens')
      .set('Authorization', `Bearer ${other.token}`)
      .send({ token: 'owned-token' });
    expect(await getTokensForUsers([owner.userId])).toEqual([{ token: 'owned-token' }]);

    const res = await request(app)
      .delete('/api/push/tokens')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ token: 'owned-token' });
    expect(res.status).toBe(200);
    expect(await getTokensForUsers([owner.userId])).toEqual([]);
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/push/tokens').send({ token: 'tok', platform: 'ios' });
    expect(res.status).toBe(401);
  });
});
