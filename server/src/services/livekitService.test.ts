import { beforeEach, describe, expect, it, vi } from 'vitest';

const addGrant = vi.fn();
const toJwt = vi.fn().mockResolvedValue('mock-jwt-token');
// Regular function, not an arrow function: production code calls `new AccessToken(...)`,
// and arrow functions can never be used as constructors (throws "is not a constructor").
const AccessTokenMock = vi.fn().mockImplementation(function AccessTokenMock() {
  return { addGrant, toJwt };
});

vi.mock('livekit-server-sdk', () => ({ AccessToken: AccessTokenMock }));

vi.mock('../config.js', () => ({
  config: {
    LIVEKIT_URL: 'ws://localhost:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
  },
}));

const { isLiveKitConfigured, mintCallToken } = await import('./livekitService.js');

describe('livekitService (configured)', () => {
  beforeEach(() => {
    AccessTokenMock.mockClear();
    addGrant.mockClear();
    toJwt.mockClear();
  });

  it('reports configured when all three env vars are set', () => {
    expect(isLiveKitConfigured()).toBe(true);
  });

  it('mints a token with a room-join grant for the given room/identity/name', async () => {
    const token = await mintCallToken('room-1', '42', 'Jane');

    expect(AccessTokenMock).toHaveBeenCalledWith('devkey', 'secret', { identity: '42', name: 'Jane' });
    expect(addGrant).toHaveBeenCalledWith({
      roomJoin: true,
      room: 'room-1',
      canPublish: true,
      canSubscribe: true,
    });
    expect(token).toBe('mock-jwt-token');
  });
});
