import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../db/testUtils.js';
import { login, register } from './authService.js';

const cred = { email: 'jm@flowerstore.ph', password: 'hunter2hunter2', displayName: 'JM' };

describe('authService', () => {
  beforeEach(resetDb);

  it('registers an allowed-domain user as member and logs in', async () => {
    const r = await register(cred);
    expect(r.user).toMatchObject({ email: cred.email, role: 'member', displayName: 'JM' });
    expect(r.accessToken).toBeTruthy();
    expect(r.refreshToken).toMatch(/^rt_/);
    const l = await login(cred.email, cred.password);
    expect(l.user.id).toBe(r.user.id);
  });

  it('normalizes email case on register and login', async () => {
    await register({ ...cred, email: 'JM@FlowerStore.PH' });
    const l = await login('jm@flowerstore.ph', cred.password);
    expect(l.user.email).toBe('jm@flowerstore.ph');
  });

  it('rejects disallowed domains with 403', async () => {
    await expect(register({ ...cred, email: 'x@gmail.com' })).rejects.toMatchObject({
      status: 403,
      code: 'domain_not_allowed',
    });
  });

  it('rejects duplicate email with 409', async () => {
    await register(cred);
    await expect(register(cred)).rejects.toMatchObject({ status: 409, code: 'email_taken' });
  });

  it('rejects wrong password and inactive users with 401', async () => {
    const r = await register(cred);
    await expect(login(cred.email, 'nope-nope-nope')).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });
    const { eq } = await import('drizzle-orm');
    const { db } = await import('../db/index.js');
    const { users } = await import('../db/schema/index.js');
    await db.update(users).set({ isActive: false }).where(eq(users.id, r.user.id));
    await expect(login(cred.email, cred.password)).rejects.toMatchObject({ status: 401 });
  });
});
