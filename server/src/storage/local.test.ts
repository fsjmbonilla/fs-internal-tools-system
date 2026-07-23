import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalStorageDriver } from './local.js';

describe('LocalStorageDriver', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-storage-test-'));
  const driver = new LocalStorageDriver(dir);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes and reads back a file, returns null for getSignedGetUrl, deletes cleanly', async () => {
    await driver.put('a/b.txt', Buffer.from('hello world'), 'text/plain');
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = driver.getStream('a/b.txt');
      stream.on('data', (c) => chunks.push(Buffer.from(c)));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe('hello world');
    expect(await driver.getSignedGetUrl('a/b.txt', 60)).toBeNull();
    await driver.delete('a/b.txt');
    expect(() => driver.getStream('a/b.txt')).toThrow();
  });
});
