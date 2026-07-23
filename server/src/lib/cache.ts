import { Memcache } from 'memcache';
import { config } from '../config.js';
import { logger } from '../logger.js';

const client = config.MEMCACHED_SERVERS ? new Memcache(config.MEMCACHED_SERVERS) : null;

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  if (!client) return undefined;
  try {
    const raw = await client.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  } catch (err) {
    logger.warn({ err, key }, 'cache get failed');
    return undefined;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(value), ttlSeconds);
  } catch (err) {
    logger.warn({ err, key }, 'cache set failed');
  }
}

export async function cacheDel(key: string): Promise<void> {
  if (!client) return;
  try {
    await client.delete(key);
  } catch (err) {
    logger.warn({ err, key }, 'cache delete failed');
  }
}
