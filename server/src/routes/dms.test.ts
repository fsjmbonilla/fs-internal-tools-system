import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('dm routes', () => {
  beforeEach(resetDb);

  it('finds-or-creates a DM and is not visible to a third party', async () => {
    const a = await makeUser(app, { email: 'a@flowerstore.ph' });
    const b = await makeUser(app, { email: 'b@flowerstore.ph' });
    const c = await makeUser(app, { email: 'c@flowerstore.ph' });

    const r1 = await request(app)
      .post('/api/dms')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ userId: b.userId });
    const r2 = await request(app)
      .post('/api/dms')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ userId: a.userId });
    expect(r1.body.channel.id).toBe(r2.body.channel.id);

    expect(
      (await request(app).get(`/api/channels/${r1.body.channel.id}`).set('Authorization', `Bearer ${c.token}`))
        .status,
    ).toBe(404);
  });

  it('lists only the caller\'s own DMs', async () => {
    const a = await makeUser(app, { email: 'a2@flowerstore.ph' });
    const b = await makeUser(app, { email: 'b2@flowerstore.ph' });
    const c = await makeUser(app, { email: 'c2@flowerstore.ph' });

    const created = await request(app)
      .post('/api/dms')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ userId: b.userId });

    const aList = await request(app).get('/api/dms').set('Authorization', `Bearer ${a.token}`);
    expect(aList.body.dms.map((d: { id: number }) => d.id)).toContain(created.body.channel.id);

    const cList = await request(app).get('/api/dms').set('Authorization', `Bearer ${c.token}`);
    expect(cList.body.dms).toHaveLength(0);
  });
});
