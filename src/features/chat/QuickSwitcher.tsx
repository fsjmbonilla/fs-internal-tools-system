import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import type { PublicUser } from '@/features/auth/authStore';
import { api } from '@/lib/api';
import { createDm, listChannels } from './api';

export function QuickSwitcher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: channelData } = useQuery({
    queryKey: ['channels'],
    queryFn: listChannels,
    enabled: open,
  });
  const { data: userData } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ users: PublicUser[] }>('/api/users'),
    enabled: open,
  });

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Jump to a channel or person…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Channels">
          {channelData?.channels
            .filter((c) => c.type !== 'dm')
            .map((c) => (
              <CommandItem
                key={c.id}
                className="min-h-11 md:min-h-8"
                value={c.name ?? ''}
                onSelect={() => {
                  navigate(`/chat/${c.id}`);
                  onOpenChange(false);
                }}
              >
                # {c.name}
              </CommandItem>
            ))}
        </CommandGroup>
        <CommandGroup heading="People">
          {userData?.users.map((u) => (
            <CommandItem
              key={u.id}
              className="min-h-11 md:min-h-8"
              value={u.displayName}
              onSelect={async () => {
                const { channel } = await createDm(u.id);
                // So a brand-new DM shows up in the sidebar's list right away
                // rather than on the next 15s refetch.
                await queryClient.invalidateQueries({ queryKey: ['dms'] });
                navigate(`/chat/${channel.id}`);
                onOpenChange(false);
              }}
            >
              {u.displayName}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
