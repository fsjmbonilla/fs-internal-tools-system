import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StorageDriver } from './types.js';

export class LocalStorageDriver implements StorageDriver {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    return join(this.root, key);
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  getStream(key: string): NodeJS.ReadableStream {
    const path = this.resolve(key);
    if (!existsSync(path)) throw new Error(`file not found: ${key}`);
    return createReadStream(path);
  }

  async getSignedGetUrl(): Promise<string | null> {
    return null;
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.resolve(prefix);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => `${prefix}${e.name}`);
    } catch (err) {
      // Nothing uploaded yet is not an error — there is simply nothing to sweep.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
