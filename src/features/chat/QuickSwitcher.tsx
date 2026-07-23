import { useQuery } from '@tanstack/react-query';
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
              value={u.displayName}
              onSelect={async () => {
                const { channel } = await createDm(u.id);
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
