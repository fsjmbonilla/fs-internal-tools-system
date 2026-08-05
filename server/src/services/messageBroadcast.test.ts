/**
 * Every producer delivers in real time — Phase 7 CRITICAL 2.
 *
 * Broadcasting used to live in the socket handler, so only a message sent *over a
 * socket* was pushed to clients. The REST route and the support automation call
 * sendMessage directly, and the client's message list updates only from
 * `message:new` — so the AI's replies never appeared until a reload. The headline
 * feature looked like it did nothing.
 *
 * These tests exercise the service directly, which is exactly the path that used
 * to be silent.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetDb } from '../db/testUtils.js';
import { makeUser } from '../testHelpers.js';
import { getIo, setIo } from '../sockets/registry.js';
import { sendMessage } from './messageService.js';

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` } as Record<string, string>);

/** Records what was emitted where, standing in for a socket server. */
function fakeIo() {
  const emitted: { room: string; event: string; payload: unknown }[] = [];
  return {
    spy: emitted,
    io: {
      to(room: string) {
        return {
          emit(event: string, payload: unknown) {
            emitted.push({ room, event, payload });
          },
        };
      },
    },
  };
}

describe('message broadcasting', () => {
  beforeEach(resetDb);

  it('pushes a message created outside the socket handler', async () => {
    const { io, spy } = fakeIo();
    // biome-ignore lint: a minimal stand-in for the socket server
    setIo(io as never);

    const user = await makeUser(app, { email: `b${Date.now()}@flowerstore.ph` });
    const channel = await request(app)
      .post('/api/channels')
      .set(auth(user.token))
      .send({ name: `c${Date.now()}`, isPrivate: false });
    const channelId = channel.body.channel.id;

    // Straight through the service — the automation's path, and the REST route's.
    const message = await sendMessage(channelId, user.userId, 'from the automation');

    const push = spy.find((e) => e.event === 'message:new');
    expect(push, 'sendMessage must broadcast').toBeDefined();
    expect(push?.room).toBe(`channel:${channelId}`);
    expect((push?.payload as { id: number; body: string }).body).toBe('from the automation');
    expect((push?.payload as { id: number }).id).toBe(message.id);
  });

  it('broadcasts exactly once, so the socket path does not double up', async () => {
    const { io, spy } = fakeIo();
    // biome-ignore lint: a minimal stand-in for the socket server
    setIo(io as never);

    const user = await makeUser(app, { email: `b2${Date.now()}@flowerstore.ph` });
    const channel = await request(app)
      .post('/api/channels')
      .set(auth(user.token))
      .send({ name: `c2${Date.now()}`, isPrivate: false });

    await request(app)
      .post(`/api/channels/${channel.body.channel.id}/messages`)
      .set(auth(user.token))
      .send({ body: 'over REST' });

    expect(spy.filter((e) => e.event === 'message:new')).toHaveLength(1);
  });

  it('works with no socket server at all, which is how tests run', async () => {
    // Explicitly cleared: the earlier tests in this file set it, and module state
    // persists, so asserting on whatever it happens to be would prove nothing.
    setIo(undefined);
    expect(getIo()).toBeUndefined();

    const user = await makeUser(app, { email: `b3${Date.now()}@flowerstore.ph` });
    const channel = await request(app)
      .post('/api/channels')
      .set(auth(user.token))
      .send({ name: `c3${Date.now()}`, isPrivate: false });

    await expect(
      sendMessage(channel.body.channel.id, user.userId, 'no io needed'),
    ).resolves.toMatchObject({ body: 'no io needed' });
  });
});
