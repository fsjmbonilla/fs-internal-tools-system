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

  it('exposes /health with the status contract', async () => {
    const res = await request(app).get('/health');
    // 200 {ok,up} with the DB reachable; 503 {degraded,down} without.
    // The contract (shape) is what every consumer relies on.
    expect([200, 503]).toContain(res.status);
    expect(['ok', 'degraded']).toContain(res.body.status);
    expect(['up', 'down']).toContain(res.body.db);
  });

  it('rejects an invalid channel id with a validation error', async () => {
    const res = await request(app).get('/api/channels/not-a-number/messages');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});
