import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuthStore } from '@/features/auth/authStore';
import { GoogleConnectCard } from '@/features/google/GoogleConnectCard';
import { SupportMailboxCard } from '@/features/google/SupportMailboxCard';

/**
 * Personal settings. Exists as of Phase 12 to host the Google cards; anything
 * user-scoped that arrives later (notification prefs, theme) belongs here too.
 */
export function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const [params, setParams] = useSearchParams();
  const [banner, setBanner] = useState<string | null>(null);

  // The OAuth callback redirects here with ?google=connected|error.
  useEffect(() => {
    const outcome = params.get('google');
    if (!outcome) return;
    setBanner(
      outcome === 'connected'
        ? 'Google connected.'
        : 'Connecting Google failed — try again.',
    );
    // Strip the param so a refresh does not re-announce stale news.
    const next = new URLSearchParams(params);
    next.delete('google');
    next.delete('kind');
    setParams(next, { replace: true });
  }, [params, setParams]);

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-4 overflow-y-auto p-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      {banner && (
        <p
          className={`rounded border px-3 py-2 text-sm ${
            banner.includes('failed')
              ? 'border-red-300 bg-red-50 text-red-700'
              : 'border-green-300 bg-green-50 text-green-700'
          }`}
        >
          {banner}
        </p>
      )}
      <GoogleConnectCard />
      {user?.role === 'admin' && <SupportMailboxCard />}
    </div>
  );
}
