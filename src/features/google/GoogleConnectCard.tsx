import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { disconnectGoogle, getGoogleAuthUrl, getGoogleStatus } from './api';

/**
 * The per-user "Connect Google" card. Four states: server not configured (the
 * card simply does not render — nothing to offer), not connected, connected,
 * and broken (Google revoked us; the same connect flow repairs it because the
 * consent prompt re-issues a refresh token).
 */
export function GoogleConnectCard() {
  const queryClient = useQueryClient();
  const { data: status } = useQuery({ queryKey: ['google-status'], queryFn: getGoogleStatus });

  const connect = useMutation({
    mutationFn: () => getGoogleAuthUrl('user'),
    onSuccess: ({ url }) => {
      // Full-page redirect: the callback lands back on /settings?google=….
      window.location.href = url;
    },
  });

  const disconnect = useMutation({
    mutationFn: () => disconnectGoogle('user'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['google-status'] }),
  });

  if (!status?.configured) return null;
  const { connected, email, broken } = status.user;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google account</CardTitle>
        <CardDescription>
          Calendar and Gmail, connected to your own Google account. Only you (and routines
          you own) can use it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        {!connected && (
          <>
            <p className="text-sm text-muted-foreground">Not connected.</p>
            <Button
              className="min-h-11 md:min-h-0"
              onClick={() => connect.mutate()}
              disabled={connect.isPending}
            >
              {connect.isPending ? 'Redirecting…' : 'Connect Google'}
            </Button>
          </>
        )}
        {connected && !broken && (
          <>
            <p className="text-sm">
              Connected as <span className="font-medium">{email}</span>
            </p>
            <Button
              variant="outline"
              className="min-h-11 md:min-h-0"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </>
        )}
        {connected && broken && (
          <>
            <p className="text-sm text-destructive">
              The connection to <span className="font-medium">{email}</span> stopped working
              — reconnect to resume.
            </p>
            <Button
              className="min-h-11 md:min-h-0"
              onClick={() => connect.mutate()}
              disabled={connect.isPending}
            >
              {connect.isPending ? 'Redirecting…' : 'Reconnect'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
