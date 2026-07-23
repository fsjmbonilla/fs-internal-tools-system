import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('upload routes', () => {
  beforeEach(resetDb);

  it('uploads a file and rejects a bad mime type', async () => {
    const u = await makeUser(app, { email: 'u@flowerstore.ph' });

    const ok = await request(app)
      .post('/api/uploads')
      .set('Authorization', `Bearer ${u.token}`)
      .attach('files', Buffer.from('a,b,c'), { filename: 'data.csv', contentType: 'text/csv' });
    expect(ok.status).toBe(201);
    expect(ok.body.attachments).toHaveLength(1);
    expect(ok.body.attachments[0].fileName).toBe('data.csv');

    const bad = await request(app)
      .post('/api/uploads')
      .set('Authorization', `Bearer ${u.token}`)
      .attach('files', Buffer.from('MZ'), { filename: 'evil.exe', contentType: 'application/x-msdownload' });
    expect(bad.status).toBe(400);
  });
});
