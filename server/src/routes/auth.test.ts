import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';

const app = createApp();
const cred = { email: 'jm@flowerstore.ph', password: 'hunter2hunter2', displayName: 'JM' };

describe('auth routes', () => {
  beforeEach(resetDb);

  it('register → login → me round-trip', async () => {
    const reg = await request(app).post('/api/auth/register').send(cred);
    expect(reg.status).toBe(201);
    expect(reg.body.user.role).toBe('member');
    expect(reg.body.refreshToken).toMatch(/^rt_/);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${reg.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(cred.email);
  });

  it('refresh rotates and reuse kills the family', async () => {
    const reg = await request(app).post('/api/auth/register').send(cred);
    const r1 = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: reg.body.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.user.email).toBe(cred.email);
    const replay = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: reg.body.refreshToken });
    expect(replay.status).toBe(401);
    const r2 = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401); // family dead
  });

  it('logout revokes the refresh token', async () => {
    const reg = await request(app).post('/api/auth/register').send(cred);
    await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: reg.body.refreshToken })
      .expect(200);
    expect(
      (await request(app).post('/api/auth/refresh').send({ refreshToken: reg.body.refreshToken }))
        .status,
    ).toBe(401);
  });

  it('rejects short passwords, bad domains, and anonymous /me', async () => {
    expect(
      (await request(app).post('/api/auth/register').send({ ...cred, password: 'short' })).status,
    ).toBe(400);
    expect(
      (await request(app).post('/api/auth/register').send({ ...cred, email: 'a@gmail.com' }))
        .status,
    ).toBe(403);
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });
});
