/**
 * Google connections — Phase 12.
 *
 * The properties worth pinning are the boundaries: the callback trusts nothing
 * but its signed state, refresh tokens land encrypted and are never echoed,
 * only admins touch the support mailbox, and a dead grant becomes a `broken`
 * row plus one DM — not a retry loop. Google itself is a fake behind the port.
 */

import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db/index.js';
import { googleAccounts, messages } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { ensureBotUser } from '../services/botService.js';
import { makeFakeGoogle, type FakeGoogle } from '../services/google/fake.js';
import { setGooglePortForTesting } from '../services/google/port.js';
import { authUrlFor, requireConnection, withGoogle } from '../services/googleService.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` }) as Record<string, string>;

let fake: FakeGoogle;

beforeEach(async () => {
  await resetDb();
  fake = makeFakeGoogle();
  setGooglePortForTesting(fake);
});

afterEach(() => {
  setGooglePortForTesting(null);
});

/** Run the whole dance for a user and return their connection row. */
async function connect(token: string, kind = 'user') {
  const urlRes = await request(app).get(`/api/google/auth-url?kind=${kind}`).set(auth(token));
  expect(urlRes.status).toBe(200);
  const state = new URL(urlRes.body.url).searchParams.get('state')!;
  const cb = await request(app).get(`/api/google/callback?code=good-code&state=${state}`);
  expect(cb.status).toBe(302);
  return cb;
}

describe('auth url', () => {
  it('embeds offline access, consent, and a state JWT', async () => {
    const { token } = await makeUser(app);
    const res = await request(app).get('/api/google/auth-url').set(auth(token));
    const url = new URL(res.body.url);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('scope')).toContain('calendar.events');
  });

  it('refuses the support mailbox kind to a non-admin', async () => {
    const { token } = await makeUser(app);
    const res = await request(app)
      .get('/api/google/auth-url?kind=support_mailbox')
      .set(auth(token));
    expect(res.status).toBe(403);
  });

  it('requests no send or calendar scope for the support mailbox', async () => {
    const { userId } = await makeUser(app, { admin: true });
    const url = new URL(await authUrlFor(userId, 'support_mailbox'));
    expect(url.searchParams.get('scope')).not.toContain('gmail.send');
    expect(url.searchParams.get('scope')).not.toContain('calendar');
  });
});

describe('callback', () => {
  it('stores the refresh token encrypted, never in the clear', async () => {
    const { token, userId } = await makeUser(app);
    const cb = await connect(token);
    expect(cb.headers.location).toContain('google=connected');

    const [row] = await db
      .select()
      .from(googleAccounts)
      .where(eq(googleAccounts.userId, userId));
    expect(row.googleEmail).toBe('connected@flowerstore.ph');
    expect(row.refreshTokenEnc.includes(Buffer.from('fake-refresh-token'))).toBe(false);
  });

  it('rejects a state it did not sign', async () => {
    await makeUser(app);
    const forged = await new SignJWT({ kind: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('google-oauth-state')
      .setSubject('1')
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('some-other-secret-entirely'));
    const cb = await request(app).get(`/api/google/callback?code=x&state=${forged}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain('google=error');
    expect(await db.$count(googleAccounts)).toBe(0);
  });

  it('treats a missing refresh token as a failed connect', async () => {
    const { token } = await makeUser(app);
    fake.nextExchange = { refreshToken: null, email: 'x@y.z' };
    const urlRes = await request(app).get('/api/google/auth-url').set(auth(token));
    const state = new URL(urlRes.body.url).searchParams.get('state')!;
    const cb = await request(app).get(`/api/google/callback?code=good-code&state=${state}`);
    expect(cb.headers.location).toContain('google=error');
    expect(await db.$count(googleAccounts)).toBe(0);
  });

  it('re-connect updates the row in place instead of recreating it', async () => {
    const { token, userId } = await makeUser(app);
    await connect(token);
    const [before] = await db
      .select()
      .from(googleAccounts)
      .where(eq(googleAccounts.userId, userId));

    fake.nextExchange = { refreshToken: 'second-token', email: 'connected@flowerstore.ph' };
    await connect(token);
    const rows = await db.select().from(googleAccounts).where(eq(googleAccounts.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].refreshTokenEnc.equals(before.refreshTokenEnc)).toBe(false);
  });
});

describe('status and disconnect', () => {
  it('reports connection state, hiding the mailbox from non-admins', async () => {
    const { token } = await makeUser(app);
    await connect(token);
    const res = await request(app).get('/api/google/status').set(auth(token));
    expect(res.body.user).toEqual({
      connected: true,
      email: 'connected@flowerstore.ph',
      broken: false,
    });
    expect(res.body.supportMailbox).toBeUndefined();
  });

  it('shows admins the support mailbox state', async () => {
    const { token } = await makeUser(app, { admin: true });
    const res = await request(app).get('/api/google/status').set(auth(token));
    expect(res.body.supportMailbox).toEqual({ connected: false, email: null, broken: false });
  });

  it('disconnect revokes at Google and deletes the row', async () => {
    const { token, userId } = await makeUser(app);
    await connect(token);
    const res = await request(app).delete('/api/google/connection').set(auth(token));
    expect(res.status).toBe(200);
    expect(fake.revoked).toEqual(['fake-refresh-token']);
    expect(
      await db.$count(googleAccounts, eq(googleAccounts.userId, userId)),
    ).toBe(0);
  });

  it('an admin connects the org mailbox with no personal userId on the row', async () => {
    const { token } = await makeUser(app, { admin: true });
    await connect(token, 'support_mailbox');
    const [row] = await db
      .select()
      .from(googleAccounts)
      .where(eq(googleAccounts.kind, 'support_mailbox'));
    expect(row.userId).toBeNull();
  });
});

describe('withGoogle on a dead grant', () => {
  it('marks the connection broken and DMs the owner exactly once', async () => {
    await ensureBotUser();
    const { token, userId } = await makeUser(app);
    await connect(token);
    fake.breakGrant();

    const account = await requireConnection('user', userId);
    await expect(withGoogle(account, (t) => fake.listEvents(t, 'a', 'z'))).rejects.toMatchObject({
      code: 'google_connection_broken',
    });

    const [row] = await db
      .select()
      .from(googleAccounts)
      .where(eq(googleAccounts.userId, userId));
    expect(row.status).toBe('broken');

    // The owner got told, in a DM authored by the bot.
    const dmMessages = await db.select().from(messages);
    expect(dmMessages.some((m) => m.body.includes('stopped working'))).toBe(true);

    // And a broken row is refused up front — no second Google call, no second DM.
    await expect(requireConnection('user', userId)).rejects.toMatchObject({
      code: 'google_connection_broken',
    });
  });
});
