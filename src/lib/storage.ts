import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const native = Capacitor.isNativePlatform();

export const storage = {
  async get(key: string): Promise<string | null> {
    if (native) return (await Preferences.get({ key })).value;
    return localStorage.getItem(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (native) await Preferences.set({ key, value });
    else localStorage.setItem(key, value);
  },
  async remove(key: string): Promise<void> {
    if (native) await Preferences.remove({ key });
    else localStorage.removeItem(key);
  },
};

export const REFRESH_TOKEN_KEY = 'fs_refresh_token';
