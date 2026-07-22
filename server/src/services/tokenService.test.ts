import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { resetDb } from '../db/testUtils.js';
import {
  createSession,
  refreshSession,
  revokeRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from './tokenService.js';

async function seedUser() {
  const [{ id }] = await db
    .insert(users)
    .values({ email: 'a@flowerstore.ph', passwordHash: 'x', displayName: 'A' })
    .$returningId();
  return { id, role: 'member' as const };
}

describe('tokenService', () => {
  beforeEach(resetDb);

  it('access token round-trips claims', async () => {
    const token = await signAccessToken({ id: 7, role: 'admin' });
    expect(await verifyAccessToken(token)).toEqual({ userId: 7, role: 'admin' });
    expect(await verifyAccessToken('garbage')).toBeNull();
  });

  it('refresh rotation: rotated tokens keep working', async () => {
    const user = await seedUser();
    const s1 = await createSession(user);
    const s2 = await refreshSession(s1.refreshToken);
    expect(s2).not.toBeNull();
    expect(s2!.userId).toBe(user.id);
    const s3 = await refreshSession(s2!.refreshToken);
    expect(s3).not.toBeNull();
  });

  it('reuse of a rotated token revokes the whole family', async () => {
    const user = await seedUser();
    const s1 = await createSession(user);
    const s2 = await refreshSession(s1.refreshToken);
    expect(await refreshSession(s1.refreshToken)).toBeNull(); // replay old
    expect(await refreshSession(s2!.refreshToken)).toBeNull(); // family dead
  });

  it('logout revokes the token', async () => {
    const user = await seedUser();
    const s1 = await createSession(user);
    await revokeRefreshToken(s1.refreshToken);
    expect(await refreshSession(s1.refreshToken)).toBeNull();
  });

  it('inactive users cannot refresh', async () => {
    const user = await seedUser();
    const s1 = await createSession(user);
    const { eq } = await import('drizzle-orm');
    await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));
    expect(await refreshSession(s1.refreshToken)).toBeNull();
  });
});
