import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { createChannel } from './channelService.js';
import { endCall, getActiveCallForChannel, getCallById, startCall } from './callService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('callService', () => {
  beforeEach(resetDb);

  it('starts a call for a channel and reuses it while still active', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const chan = await createChannel({ name: 'g', isPrivate: false, createdBy: owner });

    const first = await startCall(chan.id, owner);
    expect(first.channelId).toBe(chan.id);
    expect(first.startedBy).toBe(owner);
    expect(first.endedAt).toBeNull();

    const second = await startCall(chan.id, owner);
    expect(second.id).toBe(first.id); // reused, not a new row
    expect(second.roomName).toBe(first.roomName);
  });

  it('starts a brand-new call with a different room name after the previous one ended', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const chan = await createChannel({ name: 'g2', isPrivate: false, createdBy: owner });

    const first = await startCall(chan.id, owner);
    await endCall(first.id);
    const second = await startCall(chan.id, owner);

    expect(second.id).not.toBe(first.id);
    expect(second.roomName).not.toBe(first.roomName);
  });

  it('creates ad-hoc calls (no channel) with a unique room name each time', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const a = await startCall(null, owner);
    const b = await startCall(null, owner);
    expect(a.channelId).toBeNull();
    expect(b.channelId).toBeNull();
    expect(a.roomName).not.toBe(b.roomName);
  });

  it('getActiveCallForChannel returns null when there is no in-progress call', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const chan = await createChannel({ name: 'g3', isPrivate: false, createdBy: owner });
    expect(await getActiveCallForChannel(chan.id)).toBeNull();

    const call = await startCall(chan.id, owner);
    expect((await getActiveCallForChannel(chan.id))?.id).toBe(call.id);
    await endCall(call.id);
    expect(await getActiveCallForChannel(chan.id)).toBeNull();
  });

  it('endCall is idempotent-safe: ending an already-ended or nonexistent call returns null', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const chan = await createChannel({ name: 'g4', isPrivate: false, createdBy: owner });
    const call = await startCall(chan.id, owner);
    expect(await endCall(call.id)).not.toBeNull();
    expect(await endCall(call.id)).toBeNull(); // already ended
    expect(await endCall(999999)).toBeNull(); // doesn't exist
  });

  it('getCallById returns the row or null', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const chan = await createChannel({ name: 'g5', isPrivate: false, createdBy: owner });
    const call = await startCall(chan.id, owner);
    expect((await getCallById(call.id))?.id).toBe(call.id);
    expect(await getCallById(999999)).toBeNull();
  });
});
