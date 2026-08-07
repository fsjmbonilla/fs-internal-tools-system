/**
 * Calendar + Gmail REST — Phase 12.
 *
 * Both surfaces share one contract: personal data (`requireUserAuth`), a 409
 * with a machine-readable code when no working connection exists (the feature
 * exists — 404 would lie), and Google only ever spoken to through the port.
 * The Gmail-specific property worth pinning hardest: an HTML body is hostile
 * input and never leaves the server unsanitized.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeFakeGoogle, type FakeGoogle } from '../services/google/fake.js';
import { setGooglePortForTesting } from '../services/google/port.js';
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

async function connectedUser(opts: { admin?: boolean } = {}) {
  const user = await makeUser(app, opts);
  const urlRes = await request(app).get('/api/google/auth-url').set(auth(user.token));
  const state = new URL(urlRes.body.url).searchParams.get('state')!;
  await request(app).get(`/api/google/callback?code=good-code&state=${state}`);
  return user;
}

describe('connection contract (shared by both surfaces)', () => {
  it('409 google_not_connected when the caller never connected', async () => {
    const { token } = await makeUser(app);
    const cal = await request(app)
      .get('/api/calendar/events?from=2026-08-01&to=2026-08-31')
      .set(auth(token));
    expect(cal.status).toBe(409);
    expect(cal.body.error.code).toBe('google_not_connected');

    const mail = await request(app).get('/api/gmail/messages').set(auth(token));
    expect(mail.status).toBe(409);
    expect(mail.body.error.code).toBe('google_not_connected');
  });

  it('409 google_connection_broken once the grant dies', async () => {
    const { token } = await connectedUser();
    fake.breakGrant();
    // First call trips the invalid_grant path and marks the row broken…
    const first = await request(app)
      .get('/api/calendar/events?from=2026-08-01&to=2026-08-31')
      .set(auth(token));
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe('google_connection_broken');
    // …and the second is refused before Google is spoken to at all.
    const second = await request(app).get('/api/gmail/messages').set(auth(token));
    expect(second.body.error.code).toBe('google_connection_broken');
  });
});

describe('calendar', () => {
  it('lists events in the window', async () => {
    const { token } = await connectedUser();
    await request(app)
      .post('/api/calendar/events')
      .set(auth(token))
      .send({ title: 'Sync', start: '2026-08-10T09:00:00Z', end: '2026-08-10T09:30:00Z' });

    const res = await request(app)
      .get('/api/calendar/events?from=2026-08-01T00:00:00Z&to=2026-08-31T00:00:00Z')
      .set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].title).toBe('Sync');
  });

  it('creates an event and echoes Google’s view of it', async () => {
    const { token } = await connectedUser();
    const res = await request(app)
      .post('/api/calendar/events')
      .set(auth(token))
      .send({
        title: '#general sync',
        start: '2026-08-10T09:00:00Z',
        end: '2026-08-10T10:00:00Z',
        attendees: ['viewer@flowerstore.ph'],
        location: 'https://localhost:5173/call/general-room',
      });
    expect(res.status).toBe(201);
    expect(res.body.event.id).toMatch(/^evt_/);
    expect(res.body.event.htmlLink).toContain('calendar.google.com');
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0].attendees).toEqual(['viewer@flowerstore.ph']);
  });

  it('rejects an event that ends before it starts', async () => {
    const { token } = await connectedUser();
    const res = await request(app)
      .post('/api/calendar/events')
      .set(auth(token))
      .send({ title: 'x', start: '2026-08-10T10:00:00Z', end: '2026-08-10T09:00:00Z' });
    expect(res.status).toBe(400);
  });
});

describe('gmail', () => {
  const hostileMail = {
    id: 'm1',
    threadId: 't1',
    from: 'attacker@example.com',
    to: 'me@flowerstore.ph',
    subject: 'hello',
    snippet: 'hi',
    date: '2026-08-06T00:00:00.000Z',
    unread: true,
    bodyText: null,
    bodyHtml:
      '<p onclick="alert(1)" style="color:#e91e63">hi</p><script>steal()</script>' +
      '<img src="https://cdn.example/hero.png" onerror="steal()">' +
      '<img src="data:image/svg+xml;base64,PHN2Zz4=">' +
      '<table width="600" bgcolor="#fafafa"><tr><td align="center">cell</td></tr></table>' +
      '<a href="javascript:alert(1)">click</a><a href="https://ok.example">fine</a>',
  };

  it('lists the inbox', async () => {
    const { token } = await connectedUser();
    fake.inbox.push(hostileMail);
    const res = await request(app).get('/api/gmail/messages').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].subject).toBe('hello');
  });

  it('sanitizes an HTML body: full layout survives, nothing executable does', async () => {
    const { token } = await connectedUser();
    fake.inbox.push(hostileMail);
    const res = await request(app).get('/api/gmail/messages/m1').set(auth(token));
    const html: string = res.body.message.bodyHtml;
    expect(html).toContain('hi');
    // Executable material is gone…
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:image');
    // …while presentation survives: inline styles, table layout, https images.
    expect(html).toContain('style="color:#e91e63"');
    expect(html).toContain('width="600"');
    expect(html).toContain('align="center"');
    expect(html).toContain('src="https://cdn.example/hero.png"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('https://ok.example');
  });

  it('404s an id Gmail does not know', async () => {
    const { token } = await connectedUser();
    const res = await request(app).get('/api/gmail/messages/nope').set(auth(token));
    expect(res.status).toBe(404);
  });

  it('rejects header-injection attempts in to and subject', async () => {
    const { token } = await connectedUser();
    const viaTo = await request(app)
      .post('/api/gmail/send')
      .set(auth(token))
      .send({ to: 'a@b.co\r\nBcc: everyone@example.com', subject: 'hi', body: 'x' });
    expect(viaTo.status).toBe(400);

    // The service refuses even when route validation is bypassed — the agent
    // tool calls sendMail directly, so this layer is the one that matters.
    const { sendMail } = await import('../services/gmailService.js');
    const { userId } = await connectedUser();
    await expect(
      sendMail(userId, { to: 'a@b.co', subject: 'hi\r\nBcc: x@y.z', body: 'x' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      sendMail(userId, { to: 'not an email', subject: 'hi', body: 'x' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(fake.sent).toHaveLength(0);
  });

  it('email links come back forced to safe new-tab targets', async () => {
    const { token } = await connectedUser();
    fake.inbox.push({ ...hostileMail, id: 'm2' });
    const res = await request(app).get('/api/gmail/messages/m2').set(auth(token));
    expect(res.body.message.bodyHtml).toContain('target="_blank"');
    expect(res.body.message.bodyHtml).toContain('rel="noopener noreferrer nofollow"');
  });

  it('caches the inbox: within the sync window Google is not asked again', async () => {
    const { token } = await connectedUser();
    fake.inbox.push({ ...hostileMail, internalDate: 1_000 });
    const first = await request(app).get('/api/gmail/messages').set(auth(token));
    expect(first.body.messages).toHaveLength(1);

    // New mail arrives at Google, but the last sync is fresh — cache serves.
    fake.inbox.push({ ...hostileMail, id: 'm2', subject: 'newer', internalDate: 2_000 });
    const second = await request(app).get('/api/gmail/messages').set(auth(token));
    expect(second.body.messages).toHaveLength(1);

    // Age the sync state past the window: only the delta is fetched, appended.
    const { db } = await import('../db/index.js');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`UPDATE gmail_sync_state SET last_sync_at = NOW() - INTERVAL 5 MINUTE`);
    const third = await request(app).get('/api/gmail/messages').set(auth(token));
    expect(third.body.messages).toHaveLength(2);
    expect(third.body.messages[0].subject).toBe('newer');
  });

  it('caches a body on first open and serves it after Google forgets the message', async () => {
    const { token } = await connectedUser();
    fake.inbox.push({ ...hostileMail, internalDate: 1_000 });
    const first = await request(app).get('/api/gmail/messages/m1').set(auth(token));
    expect(first.status).toBe(200);
    expect(first.body.message.bodyHtml).not.toContain('<script');

    fake.inbox.length = 0; // Google no longer returns it; the cache must.
    const second = await request(app).get('/api/gmail/messages/m1').set(auth(token));
    expect(second.status).toBe(200);
    expect(second.body.message.bodyHtml).toContain('hi');
    expect(second.body.message.bodyHtml).not.toContain('<script');
    expect(second.body.message.to).toBe('me@flowerstore.ph');
  });

  it('replies inside the original thread with a derived subject', async () => {
    const { token } = await connectedUser();
    fake.inbox.push({ ...hostileMail, internalDate: 1_000 });
    const res = await request(app)
      .post('/api/gmail/messages/m1/reply')
      .set(auth(token))
      .send({ body: 'Thanks, on it.' });
    expect(res.status).toBe(201);
    expect(fake.sent).toEqual([
      {
        to: 'attacker@example.com',
        subject: 'Re: hello',
        body: 'Thanks, on it.',
        threadId: 't1',
      },
    ]);
  });

  it('opening a message marks it read in the cache and asks Gmail to clear UNREAD', async () => {
    const { token } = await connectedUser();
    fake.inbox.push({ ...hostileMail, unread: true, internalDate: 1_000 });
    const before = await request(app).get('/api/gmail/messages').set(auth(token));
    expect(before.body.messages[0].unread).toBe(true);

    await request(app).get('/api/gmail/messages/m1').set(auth(token)).expect(200);
    expect(fake.readMarks).toContain('m1');

    // Refresh (still inside the sync window → served from cache): stays read.
    const after = await request(app).get('/api/gmail/messages').set(auth(token));
    expect(after.body.messages[0].unread).toBe(false);
  });

  it('reply-all Ccs the original recipients; forward quotes the original to a new address', async () => {
    const { token } = await connectedUser();
    fake.inbox.push({ ...hostileMail, internalDate: 1_000 });

    await request(app)
      .post('/api/gmail/messages/m1/reply')
      .set(auth(token))
      .send({ body: 'Looping everyone in.', all: true })
      .expect(201);
    expect(fake.sent[0]).toMatchObject({
      to: 'attacker@example.com',
      cc: 'me@flowerstore.ph',
      threadId: 't1',
    });

    await request(app)
      .post('/api/gmail/messages/m1/forward')
      .set(auth(token))
      .send({ to: 'colleague@flowerstore.ph', note: 'FYI' })
      .expect(201);
    const fwd = fake.sent[1];
    expect(fwd.to).toBe('colleague@flowerstore.ph');
    expect(fwd.subject).toBe('Fwd: hello');
    expect(fwd.body).toContain('FYI');
    expect(fwd.body).toContain('Forwarded message');
    expect(fwd.body).toContain('attacker@example.com');
    expect(fwd.body).not.toContain('<script');

    await request(app)
      .post('/api/gmail/messages/m1/forward')
      .set(auth(token))
      .send({ to: 'not-an-email' })
      .expect(400);
  });

  it('saves compose and reply drafts', async () => {
    const { token } = await connectedUser();
    fake.inbox.push({ ...hostileMail, internalDate: 1_000 });

    await request(app)
      .post('/api/gmail/drafts')
      .set(auth(token))
      .send({ to: 'client@example.com', subject: 'Quote', body: 'Draft text' })
      .expect(201);
    expect(fake.drafts[0]).toMatchObject({ to: 'client@example.com', subject: 'Quote' });

    await request(app)
      .post('/api/gmail/drafts')
      .set(auth(token))
      .send({ body: 'Half-written reply', replyToMessageId: 'm1' })
      .expect(201);
    expect(fake.drafts[1]).toMatchObject({ subject: 'Re: hello', threadId: 't1' });
    expect(fake.sent).toHaveLength(0); // drafts, not sends
  });

  it('sends mail through the connected account', async () => {
    const { token } = await connectedUser();
    const res = await request(app)
      .post('/api/gmail/send')
      .set(auth(token))
      .send({ to: 'client@example.com', subject: 'Re: order', body: 'On its way.' });
    expect(res.status).toBe(201);
    expect(fake.sent).toEqual([
      { to: 'client@example.com', subject: 'Re: order', body: 'On its way.' },
    ]);
  });
});
