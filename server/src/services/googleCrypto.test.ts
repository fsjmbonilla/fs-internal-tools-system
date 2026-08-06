import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from './googleCrypto.js';

describe('googleCrypto', () => {
  it('round-trips a refresh token', () => {
    const token = '1//0gabcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOP';
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it('never produces the same blob twice (fresh IV per encryption)', () => {
    const token = 'same-plaintext';
    expect(encryptToken(token).equals(encryptToken(token))).toBe(false);
  });

  it('stores no plaintext', () => {
    const token = 'super-secret-refresh-token';
    expect(encryptToken(token).includes(Buffer.from(token, 'utf8'))).toBe(false);
  });

  it('rejects a tampered blob instead of decrypting to garbage', () => {
    const blob = encryptToken('a-token');
    blob[blob.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => decryptToken(blob)).toThrow();
  });

  it('rejects a blob encrypted under a different key shape (truncated)', () => {
    const blob = encryptToken('a-token').subarray(0, 20);
    expect(() => decryptToken(blob)).toThrow();
  });
});
