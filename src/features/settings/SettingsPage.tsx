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
    <div className="grid h-full w-full items-start gap-4 overflow-y-auto p-4 md:p-6 lg:grid-cols-2">
      <h1 className="text-xl font-semibold">Settings</h1>
      {banner && (
        <p
          role="status"
          className={`animate-in rounded border px-3 py-2 text-sm duration-150 fade-in ${
            banner.includes('failed')
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-primary/30 bg-primary/10 text-primary'
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
