import { create } from 'zustand';

export interface PublicUser {
  id: number;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  avatarUrl: string | null;
}

interface AuthState {
  user: PublicUser | null;
  accessToken: string | null;
  status: 'loading' | 'authed' | 'guest';
  setSession: (user: PublicUser, accessToken: string) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  status: 'loading',
  setSession: (user, accessToken) => set({ user, accessToken, status: 'authed' }),
  clearSession: () => set({ user: null, accessToken: null, status: 'guest' }),
}));
