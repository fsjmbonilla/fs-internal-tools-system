import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import { addChannelMember, createChannel, findOrCreateDm } from '../services/channelService.js';
import { sendMessage } from '../services/messageService.js';
import { registerPushAutomation } from './pushAutomation.js';

const { sendPushToUsers } = vi.hoisted(() => ({ sendPushToUsers: vi.fn() }));
vi.mock('../services/pushService.js', () => ({ sendPushToUsers }));

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

registerPushAutomation(); // once, like at real boot — not per-test, to avoid stacking listeners

describe('pushAutomation', () => {
  beforeEach(async () => {
    await resetDb();
    sendPushToUsers.mockReset();
  });

  it('pushes the other DM member on a new DM message', async () => {
    const a = await seedUser('a@flowerstore.ph');
    const b = await seedUser('b@flowerstore.ph');
    const dm = await findOrCreateDm(a, b);
    await sendMessage(dm.id, a, 'hi there');

    await vi.waitFor(() => expect(sendPushToUsers).toHaveBeenCalled());
    expect(sendPushToUsers).toHaveBeenCalledWith([b], { title: 'a', body: 'hi there', channelId: dm.id });
  });

  it('pushes only mentioned users on a channel message, never the author', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const jane = await seedUser('jane@flowerstore.ph');
    const bob = await seedUser('bob@flowerstore.ph');
    const chan = await createChannel({ name: 'g', isPrivate: false, createdBy: owner });
    await addChannelMember(chan.id, jane);
    await addChannelMember(chan.id, bob);

    await sendMessage(chan.id, owner, 'hey @jane check this out');

    await vi.waitFor(() => expect(sendPushToUsers).toHaveBeenCalled());
    expect(sendPushToUsers).toHaveBeenCalledWith([jane], {
      title: 'owner mentioned you',
      body: 'hey @jane check this out',
      channelId: chan.id,
    });
  });

  it('does not push at all when a channel message has no mentions', async () => {
    const owner = await seedUser('owner@flowerstore.ph');
    const chan = await createChannel({ name: 'g2', isPrivate: false, createdBy: owner });
    await sendMessage(chan.id, owner, 'no mentions here');
    await new Promise((r) => setTimeout(r, 20));
    expect(sendPushToUsers).not.toHaveBeenCalled();
  });
});
