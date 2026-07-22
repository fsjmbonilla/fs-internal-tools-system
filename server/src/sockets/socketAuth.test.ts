import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { channels, messages, users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { signAccessToken } from '../services/tokenService.js';
import { registerSocketHandlers } from './index.js';

let httpServer: ReturnType<typeof createServer>;
let url = '';

beforeAll(async () => {
  httpServer = createServer();
  const io = new Server(httpServer);
  registerSocketHandlers(io);
  await new Promise<void>((r) => httpServer.listen(0, () => r()));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => httpServer.close(() => r())));

function connect(token?: string): ClientSocket {
  return ioc(url, { auth: token ? { token } : {}, reconnection: false, timeout: 2000 });
}

describe('socket auth', () => {
  beforeEach(resetDb);

  it('rejects connections without a valid token', async () => {
    const err = await new Promise<Error>((resolve) => {
      const s = connect();
      s.on('connect_error', resolve);
    });
    expect(err.message).toBe('unauthenticated');
  });

  it('accepts a valid token and stamps message author from socket identity', async () => {
    const [{ id: userId }] = await db
      .insert(users)
      .values({ email: 's@flowerstore.ph', passwordHash: 'x', displayName: 'S' })
      .$returningId();
    const [{ id: channelId }] = await db.insert(channels).values({ name: 'g' }).$returningId();
    const token = await signAccessToken({ id: userId, role: 'member' });

    const s = connect(token);
    await new Promise<void>((resolve) => s.on('connect', () => resolve()));
    // payload tries to spoof userId 999999 — server must ignore it
    const ack = await s.emitWithAck('message:send', { channelId, body: 'hi', userId: 999_999 });
    expect(ack.ok).toBe(true);

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userId);
    s.disconnect();
  });
});
