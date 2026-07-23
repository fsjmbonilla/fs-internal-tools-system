import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { messages, users } from '../db/schema/index.js';
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
    const { createChannel } = await import('../services/channelService.js');
    const [{ id: userId }] = await db
      .insert(users)
      .values({ email: 's@flowerstore.ph', passwordHash: 'x', displayName: 'S' })
      .$returningId();
    const channel = await createChannel({ name: 'g', isPrivate: false, createdBy: userId });
    const token = await signAccessToken({ id: userId, role: 'member' });

    const s = connect(token);
    await new Promise<void>((resolve) => s.on('connect', () => resolve()));
    // payload tries to spoof userId 999999 — server must ignore it
    const ack = await s.emitWithAck('message:send', { channelId: channel.id, body: 'hi', userId: 999_999 });
    expect(ack.ok).toBe(true);

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userId);
    s.disconnect();
  });

  it('join is refused for a private channel the user cannot see; send/reactions/typing work for visible ones', async () => {
    const { createChannel } = await import('../services/channelService.js');
    const [{ id: memberId }] = await db
      .insert(users)
      .values({ email: 'member@flowerstore.ph', passwordHash: 'x', displayName: 'Member' })
      .$returningId();
    const [{ id: outsiderId }] = await db
      .insert(users)
      .values({ email: 'outsider@flowerstore.ph', passwordHash: 'x', displayName: 'Outsider' })
      .$returningId();
    const chan = await createChannel({ name: 'priv', isPrivate: true, createdBy: memberId });

    const memberToken = await signAccessToken({ id: memberId, role: 'member' });
    const outsiderToken = await signAccessToken({ id: outsiderId, role: 'member' });
    const memberSocket = connect(memberToken);
    const outsiderSocket = connect(outsiderToken);
    await Promise.all([
      new Promise<void>((resolve) => memberSocket.on('connect', () => resolve())),
      new Promise<void>((resolve) => outsiderSocket.on('connect', () => resolve())),
    ]);

    memberSocket.emit('channel:join', chan.id);
    outsiderSocket.emit('channel:join', chan.id); // should silently not join the room

    const received: unknown[] = [];
    outsiderSocket.on('message:new', (m) => received.push(m));
    const ack = await memberSocket.emitWithAck('message:send', { channelId: chan.id, body: 'secret msg' });
    expect(ack.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toHaveLength(0); // outsider never joined the room, never receives it

    const reactAck = await memberSocket.emitWithAck('message:reaction', {
      messageId: ack.message.id,
      channelId: chan.id,
      emoji: '👍',
    });
    expect(reactAck.ok).toBe(true);

    // outsider is not a channel member: send is refused
    const outsiderSendAck = await outsiderSocket.emitWithAck('message:send', {
      channelId: chan.id,
      body: 'i should not be able to send this',
    });
    expect(outsiderSendAck.ok).toBe(false);

    memberSocket.disconnect();
    outsiderSocket.disconnect();
  });
});
