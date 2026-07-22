import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('admin routes', () => {
  beforeEach(resetDb);

  it('is invisible (404) to members, usable by admins', async () => {
    const member = await makeUser(app, { email: 'm@flowerstore.ph' });
    const admin = await makeUser(app, { email: 'a@flowerstore.ph', admin: true });

    expect(
      (await request(app).get('/api/admin/users').set('Authorization', `Bearer ${member.token}`))
        .status,
    ).toBe(404);

    const list = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(list.status).toBe(200);
    expect(list.body.users).toHaveLength(2);
  });

  it('updates allowed domains and enforces them on register', async () => {
    const admin = await makeUser(app, { email: 'a@flowerstore.ph', admin: true });
    await request(app)
      .put('/api/admin/settings/allowed-domains')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ domains: ['potico.ph'] })
      .expect(200);
    expect(
      (
        await request(app)
          .post('/api/auth/register')
          .send({ email: 'x@flowerstore.ph', password: 'hunter2hunter2', displayName: 'X' })
      ).status,
    ).toBe(403);
  });

  it('role change works; self-demotion blocked; deactivated user cannot log in', async () => {
    const admin = await makeUser(app, { email: 'a@flowerstore.ph', admin: true });
    const member = await makeUser(app, { email: 'm@flowerstore.ph' });

    await request(app)
      .patch(`/api/admin/users/${member.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ role: 'admin' })
      .expect(200);

    expect(
      (
        await request(app)
          .patch(`/api/admin/users/${admin.userId}`)
          .set('Authorization', `Bearer ${admin.token}`)
          .send({ role: 'member' })
      ).status,
    ).toBe(400);

    await request(app)
      .patch(`/api/admin/users/${member.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ isActive: false })
      .expect(200);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: 'm@flowerstore.ph', password: 'hunter2hunter2' })
      ).status,
    ).toBe(401);
  });

  it('user directory lists active users; me-patch updates display name', async () => {
    const u = await makeUser(app, { email: 'u@flowerstore.ph' });
    const dir = await request(app).get('/api/users').set('Authorization', `Bearer ${u.token}`);
    expect(dir.status).toBe(200);
    expect(dir.body.users[0].email).toBe('u@flowerstore.ph');

    const patched = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ displayName: 'New Name' });
    expect(patched.status).toBe(200);
    expect(patched.body.user.displayName).toBe('New Name');
  });
});
