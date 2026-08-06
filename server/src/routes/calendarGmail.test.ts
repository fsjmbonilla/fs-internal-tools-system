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
      '<p onclick="alert(1)">hi</p><script>steal()</script>' +
      '<img src="https://tracker.example/pixel.gif">' +
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

  it('sanitizes an HTML body: no scripts, handlers, images, or js: links', async () => {
    const { token } = await connectedUser();
    fake.inbox.push(hostileMail);
    const res = await request(app).get('/api/gmail/messages/m1').set(auth(token));
    const html: string = res.body.message.bodyHtml;
    expect(html).toContain('hi');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('https://ok.example');
  });

  it('404s an id Gmail does not know', async () => {
    const { token } = await connectedUser();
    const res = await request(app).get('/api/gmail/messages/nope').set(auth(token));
    expect(res.status).toBe(404);
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
