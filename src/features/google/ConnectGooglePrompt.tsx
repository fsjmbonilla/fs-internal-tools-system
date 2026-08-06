import { Link } from 'react-router';
import type { ApiError } from '@/lib/api';

/**
 * The graceful not-connected state for /calendar and /gmail: the feature
 * exists, a connection doesn't — say so and point at the fix, never an error
 * boundary.
 */
export function ConnectGooglePrompt({ error }: { error: ApiError }) {
  const broken = error.code === 'google_connection_broken';
  const notConfigured = error.code === 'google_not_configured';
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="text-lg font-medium">
        {notConfigured
          ? 'Google is not set up on this server'
          : broken
            ? 'Your Google connection stopped working'
            : 'Connect your Google account'}
      </p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {notConfigured
          ? 'An administrator needs to configure the Google integration first.'
          : broken
            ? 'Google reports the access was revoked or expired. Reconnect to pick up where you left off.'
            : 'Calendar and Gmail live on your own Google account. Connecting takes a few seconds.'}
      </p>
      {!notConfigured && (
        <Link to="/settings" className="text-sm font-medium text-primary underline">
          {broken ? 'Reconnect in Settings' : 'Connect in Settings'}
        </Link>
      )}
    </div>
  );
}
