import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
}
