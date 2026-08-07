import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { listChannels } from '@/features/chat/api';
import {
  bindMailbox,
  disconnectGoogle,
  getGoogleAuthUrl,
  getMailboxBinding,
  unbindMailbox,
} from './api';

/**
 * Admin-only: the org support mailbox. Two steps rendered as one card —
 * connect the Gmail account, then aim its mail at a support channel. The
 * poller runs only while both halves exist.
 */
export function SupportMailboxCard() {
  const queryClient = useQueryClient();
  const { data: binding } = useQuery({
    queryKey: ['google-mailbox'],
    queryFn: getMailboxBinding,
  });
  const { data: channelData } = useQuery({ queryKey: ['channels'], queryFn: listChannels });
  const [selected, setSelected] = useState<string>('');

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['google-mailbox'] });
    void queryClient.invalidateQueries({ queryKey: ['google-status'] });
  };

  const connect = useMutation({
    mutationFn: () => getGoogleAuthUrl('support_mailbox'),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });
  const disconnect = useMutation({ mutationFn: () => disconnectGoogle('support_mailbox'), onSuccess: invalidate });
  const bind = useMutation({
    mutationFn: (channelId: number) => bindMailbox(channelId),
    onSuccess: invalidate,
  });
  const unbind = useMutation({ mutationFn: unbindMailbox, onSuccess: invalidate });

  const supportChannels = (channelData?.channels ?? []).filter((c) => c.kind === 'support');
  const boundChannel = supportChannels.find((c) => c.id === binding?.targetChannelId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Support mailbox</CardTitle>
        <CardDescription>
          Emails sent to this Gmail account become messages in a support channel, where the
          assistant files them as tickets. Checked every two minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!binding?.connected && (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <p className="text-sm text-muted-foreground">No mailbox connected.</p>
            <Button
              className="min-h-11 md:min-h-0"
              onClick={() => connect.mutate()}
              disabled={connect.isPending}
            >
              {connect.isPending ? 'Redirecting…' : 'Connect mailbox'}
            </Button>
          </div>
        )}
        {binding?.connected && (
          <>
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <p className="text-sm">
                {binding.broken ? (
                  <span className="text-destructive">
                    <span className="font-medium">{binding.email}</span> stopped working —
                    reconnect to resume ingest.
                  </span>
                ) : (
                  <>
                    Connected as <span className="font-medium">{binding.email}</span>
                  </>
                )}
              </p>
              <span className="flex gap-2">
                {binding.broken && (
                  <Button size="sm" className="min-h-11 md:min-h-0" onClick={() => connect.mutate()}>
                    Reconnect
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-11 md:min-h-0"
                  onClick={() => disconnect.mutate()}
                  disabled={disconnect.isPending}
                >
                  Disconnect
                </Button>
              </span>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {binding.targetChannelId ? (
                <>
                  <p className="flex-1 text-sm">
                    Delivering to{' '}
                    <span className="font-medium">
                      #{boundChannel?.name ?? binding.targetChannelId}
                    </span>
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11 md:min-h-0"
                    onClick={() => unbind.mutate()}
                    disabled={unbind.isPending}
                  >
                    Stop delivering
                  </Button>
                </>
              ) : (
                <>
                  <Select value={selected} onValueChange={setSelected}>
                    <SelectTrigger className="min-h-11 w-full flex-1 sm:w-auto md:min-h-0">
                      <SelectValue placeholder="Pick a support channel…" />
                    </SelectTrigger>
                    <SelectContent>
                      {supportChannels.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          #{c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="min-h-11 md:min-h-0"
                    disabled={!selected || bind.isPending}
                    onClick={() => bind.mutate(Number(selected))}
                  >
                    {bind.isPending ? 'Binding…' : 'Deliver here'}
                  </Button>
                </>
              )}
            </div>
            {supportChannels.length === 0 && !binding.targetChannelId && (
              <p className="text-xs text-muted-foreground">
                No support channels yet — create one from the sidebar's “+ Support” first.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
