import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Encryption for Google refresh tokens at rest.
 *
 * A refresh token is a standing grant to someone's mailbox and calendar, which
 * makes the `google_accounts` table the most sensitive thing in the database —
 * worse than password hashes, which at least cost a cracking run. So tokens are
 * AES-256-GCM under a key that lives only in the environment: a database dump
 * without the key yields ciphertext, and GCM's auth tag means a tampered blob
 * fails loudly instead of decrypting to garbage that gets sent to Google.
 *
 * Layout of the stored blob: 12-byte IV ‖ 16-byte auth tag ‖ ciphertext, one
 * VARBINARY column, no framing to version-skew later. A fresh random IV per
 * encryption is what makes key reuse safe under GCM — never cache or reuse one.
 */

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function key(): Buffer {
  if (!config.GOOGLE_TOKEN_ENC_KEY) {
    // Callers gate on isGoogleConfigured() first; reaching here is a bug.
    throw new Error('GOOGLE_TOKEN_ENC_KEY is not set');
  }
  return Buffer.from(config.GOOGLE_TOKEN_ENC_KEY, 'hex');
}

export function encryptToken(plaintext: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptToken(blob: Buffer): string {
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  // Throws on a wrong key or a tampered blob — the callers treat that the same
  // way as a broken grant: mark the row, tell the owner, never retry hot.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
