import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { deleteToken, getTokensForUsers } from './deviceTokenService.js';
import { filterOffline } from './presence.js';

const FCM_MAX_BATCH_SIZE = 500;

export interface PushPayload {
  title: string;
  body: string;
  channelId: number;
}

let app: ReturnType<typeof initializeApp> | null | undefined;

function getApp(): ReturnType<typeof initializeApp> | null {
  if (app !== undefined) return app;
  if (!config.FIREBASE_PROJECT_ID || !config.FIREBASE_CLIENT_EMAIL || !config.FIREBASE_PRIVATE_KEY) {
    app = null; // push disabled — no Firebase credentials configured
    return app;
  }
  app = initializeApp({
    credential: cert({
      projectId: config.FIREBASE_PROJECT_ID,
      clientEmail: config.FIREBASE_CLIENT_EMAIL,
      privateKey: config.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
  return app;
}

export async function sendPushToUsers(userIds: number[], payload: PushPayload): Promise<void> {
  const firebaseApp = getApp();
  if (!firebaseApp) return; // no-op when unconfigured

  const targetUserIds = filterOffline(userIds);
  if (targetUserIds.length === 0) return;

  const tokens = await getTokensForUsers(targetUserIds);
  if (tokens.length === 0) return;

  const messaging = getMessaging(firebaseApp);
  for (let i = 0; i < tokens.length; i += FCM_MAX_BATCH_SIZE) {
    const batch = tokens.slice(i, i + FCM_MAX_BATCH_SIZE);
    const response = await messaging.sendEachForMulticast({
      tokens: batch.map((t) => t.token),
      notification: { title: payload.title, body: payload.body },
      data: { channelId: String(payload.channelId) },
    });
    await Promise.all(
      response.responses.map(async (r, idx) => {
        if (r.success) return;
        if (r.error?.code === 'messaging/registration-token-not-registered') {
          await deleteToken(batch[idx].token);
        } else {
          logger.warn({ err: r.error, token: batch[idx].token }, 'push send failed');
        }
      }),
    );
  }
}
