import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwords.js';

describe('passwords', () => {
  it('hashes and verifies round-trip', async () => {
    const hash = await hashPassword('s3cret-pw');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 's3cret-pw')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('verify never throws on malformed hashes', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false);
  });
});
