import { useAuthStore } from '@/features/auth/authStore';
import { REFRESH_TOKEN_KEY, storage } from './storage';

const BASE = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let refreshInFlight: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  const refreshToken = await storage.get(REFRESH_TOKEN_KEY);
  if (!refreshToken) return false;
  const res = await fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  }).catch(() => null);
  if (!res?.ok) {
    if (res) {
      // token invalid/reused — drop the dead session
      await storage.remove(REFRESH_TOKEN_KEY);
      useAuthStore.getState().clearSession();
    }
    return false;
  }
  const data = await res.json();
  await storage.set(REFRESH_TOKEN_KEY, data.refreshToken);
  useAuthStore.getState().setSession(data.user, data.accessToken);
  return true;
}

export function refreshOnce(): Promise<boolean> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, auth = true } = opts;
  const exec = async (): Promise<Response> => {
    const token = useAuthStore.getState().accessToken;
    return fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };
  let res = await exec();
  if (res.status === 401 && auth && (await refreshOnce())) res = await exec();
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      payload?.error?.code ?? 'unknown',
      payload?.error?.message ?? res.statusText,
    );
  }
  return res.json() as Promise<T>;
}
