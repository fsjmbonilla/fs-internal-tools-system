import { afterEach, describe, expect, it, vi } from 'vitest';

describe('cache (no memcached configured)', () => {
  afterEach(() => vi.resetModules());

  it('get always misses, set/del are no-ops, nothing throws', async () => {
    vi.stubEnv('MEMCACHED_SERVERS', '');
    const { cacheDel, cacheGet, cacheSet } = await import('./cache.js');
    expect(await cacheGet('k')).toBeUndefined();
    await expect(cacheSet('k', { a: 1 }, 60)).resolves.toBeUndefined();
    await expect(cacheDel('k')).resolves.toBeUndefined();
  });
});
