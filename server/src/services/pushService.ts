import * as firebase from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from '../logger.js';
import { deleteToken, getTokensForUsers } from './deviceTokenService.js';
import { filterOffline } from './presence.js';
import { getFirebaseConfig } from './integrationsCache.js';

const FCM_MAX_BATCH_SIZE = 500;

export interface PushPayload {
  title: string;
  body: string;
  channelId: number;
}

let app: ReturnType<typeof firebase.initializeApp> | null = null;
/** The creds the current app was built from — a change means rebuild. */
let appCredsSig: string | undefined;

/**
 * Credentials resolve at send time: the admin-set integrations values if
 * present, else the FIREBASE_* env vars. The app is memoized per credential
 * set, so an admin saving new Firebase creds rebuilds the client on the next
 * push — no restart, no explicit re-init hook.
 */
async function getApp(): Promise<ReturnType<typeof firebase.initializeApp> | null> {
  const { projectId, clientEmail, privateKey } = getFirebaseConfig();
  if (!projectId || !clientEmail || !privateKey) {
    if (app) await teardown(); // creds were removed at runtime — stop sending
    return null; // push disabled — no Firebase credentials configured
  }
  const sig = `${projectId}\n${clientEmail}\n${privateKey}`;
  if (app && appCredsSig === sig) return app;
  if (app) await teardown();
  app = firebase.initializeApp({
    credential: firebase.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    }),
  });
  appCredsSig = sig;
  return app;
}

async function teardown(): Promise<void> {
  const old = app;
  app = null;
  appCredsSig = undefined;
  // deleteApp frees the default-app name for the rebuild. Optional-called so a
  // partial firebase-admin mock (the tests stub only initializeApp/cert) works.
  if (old) await firebase.deleteApp?.(old)?.catch?.(() => undefined);
}

export async function sendPushToUsers(userIds: number[], payload: PushPayload): Promise<void> {
  const firebaseApp = await getApp();
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
