import { Capacitor } from '@capacitor/core';
import { type ActionPerformed, PushNotifications, type Token } from '@capacitor/push-notifications';
import { router } from '@/app/router';
import { api } from './api';

type NativePlatform = 'ios' | 'android';

function nativePlatform(): NativePlatform | null {
  const platform = Capacitor.getPlatform();
  return platform === 'ios' || platform === 'android' ? platform : null;
}

let registeredToken: string | null = null;

export async function initPush(): Promise<void> {
  const platform = nativePlatform();
  if (!platform) return; // web push needs a service worker + VAPID key — out of scope this phase

  const current = await PushNotifications.checkPermissions();
  const granted =
    current.receive === 'granted' ||
    (await PushNotifications.requestPermissions()).receive === 'granted';
  if (!granted) return;

  await PushNotifications.addListener('registration', (token: Token) => {
    registeredToken = token.value;
    api('/api/push/tokens', { method: 'POST', body: { token: token.value, platform } }).catch(() => {
      // best-effort — the next successful register() call will retry
    });
  });

  await PushNotifications.addListener('registrationError', () => {
    // best-effort — user simply won't receive push until the next successful register() call
  });

  await PushNotifications.addListener('pushNotificationActionPerformed', (action: ActionPerformed) => {
    const channelId = action.notification.data?.channelId;
    if (channelId) void router.navigate(`/chat/${channelId}`);
  });

  await PushNotifications.register();
}

export async function teardownPush(): Promise<void> {
  if (!nativePlatform() || !registeredToken) return;
  await api('/api/push/tokens', { method: 'DELETE', body: { token: registeredToken } }).catch(() => {});
  await PushNotifications.removeAllListeners();
  registeredToken = null;
}
