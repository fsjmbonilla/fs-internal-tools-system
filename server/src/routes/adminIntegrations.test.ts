/**
 * Runtime integration settings (admin → Integrations tab).
 *
 * The properties worth protecting:
 * - secrets are write-only: a stored key is never echoed by any response, and
 *   at rest it is ciphertext, not the value;
 * - resolution is DB-first with env fallback, and clearing a DB value really
 *   does return the consumer to the env var;
 * - the surface is invisible (404) to non-admins, like the rest of /admin.
 */
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { settings } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { getAiConfig, getFirebaseConfig, getSecret } from '../services/integrationsCache.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();

describe('admin integration settings', () => {
  beforeEach(resetDb);

  async function admin() {
    const { token } = await makeUser(app, { email: 'a@flowerstore.ph', admin: true });
    return (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  }

  it('is invisible (404) to members, on both verbs', async () => {
    const member = await makeUser(app, { email: 'm@flowerstore.ph' });
    const get = await request(app)
      .get('/api/admin/settings/integrations')
      .set('Authorization', `Bearer ${member.token}`);
    expect(get.status).toBe(404);
    const put = await request(app)
      .put('/api/admin/settings/integrations')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ai: { provider: 'openai', model: 'gpt-4.1-mini' } });
    expect(put.status).toBe(404);
  });

  it('defaults to the environment and says so', async () => {
    const auth = await admin();
    const res = await auth(request(app).get('/api/admin/settings/integrations')).expect(200);
    expect(res.body.ai).toEqual({
      provider: config.AI_PROVIDER,
      model: config.AI_MODEL ?? '',
      source: 'env',
    });
    // Whether each secret is "set" depends on the developer's .env, but with no
    // DB row the source can only ever be the environment or nothing.
    for (const name of ['openai_api_key', 'anthropic_api_key', 'firebase_private_key']) {
      expect(res.body.secrets[name].source).not.toBe('db');
      expect(res.body.secrets[name]).not.toHaveProperty('value');
    }
    expect(res.body.firebase.source).not.toBe('db');
  });

  it('round-trips the AI config and switches what getAiConfig() resolves', async () => {
    const auth = await admin();
    await auth(request(app).put('/api/admin/settings/integrations'))
      .send({ ai: { provider: 'anthropic', model: 'claude-opus-5' } })
      .expect(200);

    const res = await auth(request(app).get('/api/admin/settings/integrations')).expect(200);
    expect(res.body.ai).toEqual({ provider: 'anthropic', model: 'claude-opus-5', source: 'db' });
    // The consumers' accessor reflects the save immediately — no restart.
    expect(getAiConfig()).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });

    // ai: null clears the override; resolution returns to the env vars.
    await auth(request(app).put('/api/admin/settings/integrations')).send({ ai: null }).expect(200);
    expect(getAiConfig()).toEqual({ provider: config.AI_PROVIDER, model: config.AI_MODEL ?? '' });
  });

  it('stores a secret encrypted, never echoes it, and clears back to env', async () => {
    const auth = await admin();
    const plaintext = 'sk-test-integrations-secret-9c41';

    const put = await auth(request(app).put('/api/admin/settings/integrations'))
      .send({ secrets: { openai_api_key: plaintext } })
      .expect(200);
    // Write-only: neither the PUT response nor the GET carries the value.
    expect(JSON.stringify(put.body)).not.toContain(plaintext);
    const get = await auth(request(app).get('/api/admin/settings/integrations')).expect(200);
    expect(JSON.stringify(get.body)).not.toContain(plaintext);
    expect(get.body.secrets.openai_api_key).toEqual({ set: true, source: 'db' });

    // At rest it is AES-GCM ciphertext, not the value.
    const [row] = await db.select().from(settings).where(eq(settings.key, 'secret_openai_api_key'));
    expect(row).toBeDefined();
    expect(String(row.value)).not.toContain(plaintext);

    // The consumer accessor gets the plaintext back.
    expect(getSecret('openai_api_key')).toBe(plaintext);

    // null clears the row and resolution falls back to the env var.
    await auth(request(app).put('/api/admin/settings/integrations'))
      .send({ secrets: { openai_api_key: null } })
      .expect(200);
    expect(getSecret('openai_api_key')).toBe(config.OPENAI_API_KEY);
    const cleared = await auth(request(app).get('/api/admin/settings/integrations')).expect(200);
    expect(cleared.body.secrets.openai_api_key.source).not.toBe('db');
  });

  it('round-trips Firebase fields, merging partial updates', async () => {
    const auth = await admin();
    await auth(request(app).put('/api/admin/settings/integrations'))
      .send({
        firebase: { projectId: 'fs-internal', clientEmail: 'svc@fs-internal.iam.gserviceaccount.com' },
        secrets: { firebase_private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' },
      })
      .expect(200);

    // A later save touching one field must not lose the other.
    await auth(request(app).put('/api/admin/settings/integrations'))
      .send({ firebase: { projectId: 'fs-internal-2' } })
      .expect(200);

    const res = await auth(request(app).get('/api/admin/settings/integrations')).expect(200);
    expect(res.body.firebase).toEqual({
      projectId: 'fs-internal-2',
      clientEmail: 'svc@fs-internal.iam.gserviceaccount.com',
      source: 'db',
    });
    expect(getFirebaseConfig()).toEqual({
      projectId: 'fs-internal-2',
      clientEmail: 'svc@fs-internal.iam.gserviceaccount.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    });
  });

  it('rejects a bad provider, an empty model, and an empty secret', async () => {
    const auth = await admin();
    await auth(request(app).put('/api/admin/settings/integrations'))
      .send({ ai: { provider: 'gemini', model: 'x' } })
      .expect(400);
    await auth(request(app).put('/api/admin/settings/integrations'))
      .send({ ai: { provider: 'openai', model: '   ' } })
      .expect(400);
    // '' is neither "set it to nothing" nor "clear it" — reject rather than guess.
    await auth(request(app).put('/api/admin/settings/integrations'))
      .send({ secrets: { anthropic_api_key: '' } })
      .expect(400);
  });

  it('resetDb clears the cache, so one test cannot configure the next', async () => {
    // The beforeEach already ran; nothing set in this test — the accessor must
    // be on env fallback even though earlier tests saved DB values.
    expect(getAiConfig()).toEqual({ provider: config.AI_PROVIDER, model: config.AI_MODEL ?? '' });
  });
});
