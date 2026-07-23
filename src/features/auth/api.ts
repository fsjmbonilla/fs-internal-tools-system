import { api, refreshOnce } from '@/lib/api';
import { connectSocket, disconnectSocket } from '@/lib/socket';
import { REFRESH_TOKEN_KEY, storage } from '@/lib/storage';
import { type PublicUser, useAuthStore } from './authStore';

interface SessionResponse {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

async function adopt(session: SessionResponse): Promise<void> {
  await storage.set(REFRESH_TOKEN_KEY, session.refreshToken);
  useAuthStore.getState().setSession(session.user, session.accessToken);
  connectSocket();
}

export async function loginUser(email: string, password: string): Promise<void> {
  await adopt(
    await api<SessionResponse>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),
  );
}

export async function registerUser(
  email: string,
  password: string,
  displayName: string,
): Promise<void> {
  await adopt(
    await api<SessionResponse>('/api/auth/register', {
      method: 'POST',
      body: { email, password, displayName },
      auth: false,
    }),
  );
}

export async function logoutUser(): Promise<void> {
  disconnectSocket();
  const refreshToken = await storage.get(REFRESH_TOKEN_KEY);
  if (refreshToken) {
    await api('/api/auth/logout', {
      method: 'POST',
      body: { refreshToken },
      auth: false,
    }).catch(() => {});
  }
  await storage.remove(REFRESH_TOKEN_KEY);
  useAuthStore.getState().clearSession();
}

export async function bootstrapAuth(): Promise<void> {
  const ok = await refreshOnce();
  if (ok) connectSocket();
  else useAuthStore.getState().clearSession();
}
