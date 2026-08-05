import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendEachForMulticast = vi.fn();
vi.mock('firebase-admin/app', () => ({ initializeApp: vi.fn(() => ({})), cert: vi.fn() }));
vi.mock('firebase-admin/messaging', () => ({ getMessaging: () => ({ sendEachForMulticast }) }));

vi.mock('../config.js', () => ({
  config: { FIREBASE_PROJECT_ID: undefined, FIREBASE_CLIENT_EMAIL: undefined, FIREBASE_PRIVATE_KEY: undefined },
}));

const getTokensForUsers = vi.fn();
vi.mock('./deviceTokenService.js', () => ({ getTokensForUsers, deleteToken: vi.fn() }));
vi.mock('./presence.js', () => ({ filterOffline: vi.fn((ids: number[]) => ids) }));

const { sendPushToUsers } = await import('./pushService.js');

describe('pushService (unconfigured)', () => {
  beforeEach(() => {
    sendEachForMulticast.mockReset();
    getTokensForUsers.mockReset();
  });

  it('no-ops entirely when Firebase credentials are not set — never touches the DB or FCM', async () => {
    await sendPushToUsers([1], { title: 't', body: 'b', channelId: 1 });
    expect(getTokensForUsers).not.toHaveBeenCalled();
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });
});
