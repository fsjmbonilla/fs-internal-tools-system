import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const app = createApp();

describe('app', () => {
  it('returns the standard error envelope for unknown routes', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('reports healthy with the database reachable', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('requires auth before validating a channel id (401, not a leaked 400)', async () => {
    const res = await request(app).get('/api/channels/not-a-number/messages');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });
});
