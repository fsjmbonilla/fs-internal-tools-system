/**
 * Phase 5 Part A — the hardening that has to stay on.
 *
 * These assert properties of the HTTP surface itself (headers, what reaches the
 * log, what a spoofed upload can do), which no feature test covers.
 */

import { Buffer } from 'node:buffer';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { REDACTED_PATHS } from '../logger.js';
import { INLINEABLE, verifyMime } from '../services/attachmentService.js';
import { makeUser } from '../testHelpers.js';

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` } as Record<string, string>);

// Smallest valid files of each type, so the sniffer has real magic bytes to read.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');
const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>', 'utf8');

describe('baseline HTTP hardening', () => {
  it('does not advertise the framework', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets the headers helmet is here for', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('redacts credentials out of the log stream', () => {
    // pino redaction is configured once; assert the paths that carry secrets are
    // covered rather than capturing a log line.
    expect(REDACTED_PATHS).toContain('req.headers.authorization');
    expect(REDACTED_PATHS).toContain('req.headers.cookie');
  });
});

describe('upload MIME verification', () => {
  beforeEach(resetDb);

  it('accepts a file whose bytes match its declared type', async () => {
    expect(await verifyMime(PNG, 'image/png')).toBe(true);
    expect(await verifyMime(PDF, 'application/pdf')).toBe(true);
  });

  it('rejects a payload masquerading as an image', async () => {
    // The declared type used to be the only check, so this passed the whitelist
    // and was later served back as image/png.
    expect(await verifyMime(HTML, 'image/png')).toBe(false);
  });

  it('rejects a type that is not on the whitelist at all', async () => {
    expect(await verifyMime(HTML, 'text/html')).toBe(false);
  });

  it('allows CSV, which has no magic bytes to sniff', async () => {
    expect(await verifyMime(Buffer.from('a,b\n1,2\n'), 'text/csv')).toBe(true);
  });

  it('rejects a spoofed upload over HTTP and names it in the response', async () => {
    const user = await makeUser(app, { email: 'up1@flowerstore.ph' });
    const res = await request(app)
      .post('/api/uploads')
      .set(auth(user.token))
      .attach('files', HTML, { filename: 'evil.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0].fileName).toBe('evil.png');
  });

  it('keeps the valid files of a mixed batch and reports the rest', async () => {
    const user = await makeUser(app, { email: 'up2@flowerstore.ph' });
    const res = await request(app)
      .post('/api/uploads')
      .set(auth(user.token))
      .attach('files', PNG, { filename: 'real.png', contentType: 'image/png' })
      .attach('files', HTML, { filename: 'fake.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].fileName).toBe('real.png');
    // Silently dropping this left the composer showing fewer chips than files.
    expect(res.body.rejected.map((r: { fileName: string }) => r.fileName)).toEqual(['fake.png']);
  });
});

describe('file download headers', () => {
  beforeEach(resetDb);

  async function uploadAndAttachToMessage(token: string, file: Buffer, filename: string, mime: string) {
    const channel = await request(app)
      .post('/api/channels')
      .set(auth(token))
      .send({ name: `c${Date.now()}${Math.floor(Math.random() * 1e5)}`, isPrivate: false });
    const up = await request(app)
      .post('/api/uploads')
      .set(auth(token))
      .attach('files', file, { filename, contentType: mime });
    expect(up.status).toBe(201);
    const msg = await request(app)
      .post(`/api/channels/${channel.body.channel.id}/messages`)
      .set(auth(token))
      .send({ body: 'see attached', attachmentIds: [up.body.attachments[0].id] });
    expect(msg.status).toBe(201);
    return up.body.attachments[0].id as number;
  }

  it('serves an image inline, with sniffing disabled and a sandbox CSP', async () => {
    const user = await makeUser(app, { email: 'dl1@flowerstore.ph', admin: true });
    const id = await uploadAndAttachToMessage(user.token, PNG, 'shot.png', 'image/png');

    const res = await request(app).get(`/api/files/${id}`).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('forces anything else to download', async () => {
    const user = await makeUser(app, { email: 'dl2@flowerstore.ph', admin: true });
    const id = await uploadAndAttachToMessage(user.token, Buffer.from('a,b\n1,2\n'), 'data.csv', 'text/csv');

    const res = await request(app).get(`/api/files/${id}`).set(auth(user.token));
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(INLINEABLE.has('text/csv')).toBe(false);
  });

  it('escapes filenames that would otherwise break the header', async () => {
    const { create, parse } = await import('content-disposition');

    // What the route used to do by hand: `filename="${name}"`. A quote in the
    // name closes the quoted-string early, and the client silently saves the
    // file under a truncated name rather than erroring.
    expect(parse('inline; filename="my"file".png"').parameters.filename).toBe('my');

    // What it does now — the quote is escaped and the name survives a round trip.
    const quoted = create('my"file".png', { type: 'inline' });
    expect(quoted).toContain('\\"');
    expect(parse(quoted).parameters.filename).toBe('my"file".png');

    // Non-ASCII needs the RFC 6266 extended form, which hand-rolling also missed.
    expect(create('quarterly-café.pdf', { type: 'attachment' })).toContain("filename*=UTF-8''");
  });

  it('serves a file whose name needs escaping', async () => {
    const user = await makeUser(app, { email: 'dl3@flowerstore.ph', admin: true });
    const id = await uploadAndAttachToMessage(user.token, PNG, 'quarterly report.png', 'image/png');

    const res = await request(app).get(`/api/files/${id}`).set(auth(user.token));
    expect(res.status).toBe(200);
    const { parse } = await import('content-disposition');
    expect(() => parse(res.headers['content-disposition'])).not.toThrow();
  });
});
