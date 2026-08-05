import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

vi.mock('../services/livekitService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/livekitService.js')>();
  return {
    ...actual,
    isLiveKitConfigured: vi.fn(() => true),
    mintCallToken: vi.fn(async () => 'mock-jwt-token'),
  };
});

// Override only LIVEKIT_URL so res.body.serverUrl is deterministic in tests, regardless of
// whatever (if anything) is in the local, gitignored .env. Every other config field (JWT_SECRET,
// corsOrigins, DB_*, ...) stays real since createApp()/requireAuth/makeUser depend on them.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { config: { ...actual.config, LIVEKIT_URL: 'wss://test.example' } };
});

const app = createApp();

describe('calls routes', () => {
  beforeEach(resetDb);

  it('starts a call for a channel the caller is a member of', async () => {
    const owner = await makeUser(app, { email: 'owner@flowerstore.ph' });
    const chan = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'g', isPrivate: false });

    const res = await request(app)
      .post('/api/calls')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ channelId: chan.body.channel.id });

    expect(res.status).toBe(201);
    expect(res.body.call.channelId).toBe(chan.body.channel.id);
    expect(res.body.token).toBe('mock-jwt-token');
    expect(res.body.serverUrl).toBe('wss://test.example');
  });

  it('404s for a channel the caller cannot see', async () => {
    const owner = await makeUser(app, { email: 'owner2@flowerstore.ph' });
    const outsider = await makeUser(app, { email: 'outsider@flowerstore.ph' });
    const chan = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'secret', isPrivate: true });

    const res = await request(app)
      .post('/api/calls')
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ channelId: chan.body.channel.id });

    expect(res.status).toBe(404);
  });

  it('supports ad-hoc calls with no channelId', async () => {
    const u = await makeUser(app, { email: 'u@flowerstore.ph' });
    const res = await request(app).post('/api/calls').set('Authorization', `Bearer ${u.token}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.call.channelId).toBeNull();
  });

  it('ends a call and rejects ending it twice', async () => {
    const owner = await makeUser(app, { email: 'owner3@flowerstore.ph' });
    const chan = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'g2', isPrivate: false });
    const started = await request(app)
      .post('/api/calls')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ channelId: chan.body.channel.id });

    const ended = await request(app)
      .post(`/api/calls/${started.body.call.id}/end`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(ended.status).toBe(200);

    const endedAgain = await request(app)
      .post(`/api/calls/${started.body.call.id}/end`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(endedAgain.status).toBe(400);
  });

  it('GET /api/channels/:id/call returns the active call or null', async () => {
    const owner = await makeUser(app, { email: 'owner4@flowerstore.ph' });
    const chan = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'g3', isPrivate: false });

    const before = await request(app)
      .get(`/api/channels/${chan.body.channel.id}/call`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(before.body.call).toBeNull();

    await request(app)
      .post('/api/calls')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ channelId: chan.body.channel.id });

    const after = await request(app)
      .get(`/api/channels/${chan.body.channel.id}/call`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(after.body.call).not.toBeNull();
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/calls').send({});
    expect(res.status).toBe(401);
  });
});
