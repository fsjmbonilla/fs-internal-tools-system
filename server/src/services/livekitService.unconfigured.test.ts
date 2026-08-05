import { describe, expect, it, vi } from 'vitest';

vi.mock('livekit-server-sdk', () => ({ AccessToken: vi.fn() }));
vi.mock('../config.js', () => ({
  config: { LIVEKIT_URL: undefined, LIVEKIT_API_KEY: undefined, LIVEKIT_API_SECRET: undefined },
}));

const { isLiveKitConfigured } = await import('./livekitService.js');

describe('livekitService (unconfigured)', () => {
  it('reports not configured when any env var is missing', () => {
    expect(isLiveKitConfigured()).toBe(false);
  });
});
