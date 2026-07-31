import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import {
  deleteToken,
  getTokensForUsers,
  registerDeviceToken,
  unregisterDeviceToken,
} from './deviceTokenService.js';

async function seedUser(email: string) {
  const [{ id }] = await db
    .insert(users)
    .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
    .$returningId();
  return id;
}

describe('deviceTokenService', () => {
  beforeEach(resetDb);

  it('registers a token and returns it for that user', async () => {
    const u = await seedUser('u@flowerstore.ph');
    await registerDeviceToken(u, 'tok-1', 'android');
    expect(await getTokensForUsers([u])).toEqual([{ token: 'tok-1' }]);
  });

  it('re-registering the same token for a different user reassigns ownership', async () => {
    const a = await seedUser('a@flowerstore.ph');
    const b = await seedUser('b@flowerstore.ph');
    await registerDeviceToken(a, 'shared-device', 'ios');
    await registerDeviceToken(b, 'shared-device', 'ios');
    expect(await getTokensForUsers([a])).toEqual([]);
    expect(await getTokensForUsers([b])).toEqual([{ token: 'shared-device' }]);
  });

  it('unregisterDeviceToken only removes the caller-owned row', async () => {
    const a = await seedUser('a@flowerstore.ph');
    const b = await seedUser('b@flowerstore.ph');
    await registerDeviceToken(a, 'tok-a', 'web');
    await unregisterDeviceToken(b, 'tok-a'); // b doesn't own it — no-op
    expect(await getTokensForUsers([a])).toEqual([{ token: 'tok-a' }]);
    await unregisterDeviceToken(a, 'tok-a');
    expect(await getTokensForUsers([a])).toEqual([]);
  });

  it('deleteToken removes a token regardless of owner (stale-token GC path)', async () => {
    const u = await seedUser('u@flowerstore.ph');
    await registerDeviceToken(u, 'stale', 'android');
    await deleteToken('stale');
    expect(await getTokensForUsers([u])).toEqual([]);
  });

  it('getTokensForUsers spans multiple users, and an empty array short-circuits', async () => {
    const a = await seedUser('a@flowerstore.ph');
    const b = await seedUser('b@flowerstore.ph');
    await registerDeviceToken(a, 'tok-a', 'ios');
    await registerDeviceToken(b, 'tok-b', 'android');
    const tokens = (await getTokensForUsers([a, b])).map((t) => t.token).sort();
    expect(tokens).toEqual(['tok-a', 'tok-b']);
    expect(await getTokensForUsers([])).toEqual([]);
  });
});
