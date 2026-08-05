import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendEachForMulticast = vi.fn();
const initializeApp = vi.fn(() => ({}));
const cert = vi.fn((c: unknown) => c);
const getMessaging = vi.fn(() => ({ sendEachForMulticast }));

vi.mock('firebase-admin/app', () => ({ initializeApp, cert }));
vi.mock('firebase-admin/messaging', () => ({ getMessaging }));

vi.mock('../config.js', () => ({
  config: {
    FIREBASE_PROJECT_ID: 'proj',
    FIREBASE_CLIENT_EMAIL: 'svc@proj.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
  },
}));

const getTokensForUsers = vi.fn();
const deleteToken = vi.fn();
vi.mock('./deviceTokenService.js', () => ({ getTokensForUsers, deleteToken }));

const filterOffline = vi.fn((ids: number[]) => ids);
vi.mock('./presence.js', () => ({ filterOffline }));

const { sendPushToUsers } = await import('./pushService.js');

describe('pushService (configured)', () => {
  beforeEach(() => {
    sendEachForMulticast.mockReset();
    getTokensForUsers.mockReset();
    deleteToken.mockReset();
    filterOffline.mockReset().mockImplementation((ids: number[]) => ids);
  });

  it('sends to offline users only, skipping online ones', async () => {
    filterOffline.mockImplementation((ids: number[]) => ids.filter((id) => id !== 2));
    getTokensForUsers.mockResolvedValue([{ token: 't1' }]);
    sendEachForMulticast.mockResolvedValue({
      responses: [{ success: true }],
      successCount: 1,
      failureCount: 0,
    });

    await sendPushToUsers([1, 2], { title: 'Jane', body: 'hi', channelId: 5 });

    expect(getTokensForUsers).toHaveBeenCalledWith([1]);
    expect(sendEachForMulticast).toHaveBeenCalledWith({
      tokens: ['t1'],
      notification: { title: 'Jane', body: 'hi' },
      data: { channelId: '5' },
    });
  });

  it('deletes tokens FCM reports as unregistered, leaves others alone', async () => {
    getTokensForUsers.mockResolvedValue([{ token: 'dead' }, { token: 'alive' }]);
    sendEachForMulticast.mockResolvedValue({
      responses: [
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: true },
      ],
      successCount: 1,
      failureCount: 1,
    });

    await sendPushToUsers([1], { title: 't', body: 'b', channelId: 1 });

    expect(deleteToken).toHaveBeenCalledWith('dead');
    expect(deleteToken).not.toHaveBeenCalledWith('alive');
  });

  it('is a no-op when no target user has a device token', async () => {
    getTokensForUsers.mockResolvedValue([]);
    await sendPushToUsers([1], { title: 't', body: 'b', channelId: 1 });
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('is a no-op when every target user is online', async () => {
    filterOffline.mockReturnValue([]);
    await sendPushToUsers([1, 2], { title: 't', body: 'b', channelId: 1 });
    expect(getTokensForUsers).not.toHaveBeenCalled();
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });
});
