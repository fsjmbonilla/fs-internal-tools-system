import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';

interface AdminUser {
  id: number;
  displayName: string;
  email: string;
  isActive: boolean;
}

/**
 * Hand a departing colleague's notes to someone who is staying.
 *
 * Shows only a count, never content: the transfer moves ownership and gives the
 * admin running it no way to read the notes. Wording says so, because an admin
 * about to press this should know exactly what it does and does not grant.
 */
export function TransferNotesDialog({
  user,
  users,
}: {
  user: AdminUser;
  users: AdminUser[];
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [toUserId, setToUserId] = useState('');
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: countData } = useQuery({
    queryKey: ['admin', 'notes-count', user.id],
    queryFn: () => api<{ count: number }>(`/api/admin/users/${user.id}/notes/count`),
    enabled: open,
  });

  const transfer = useMutation({
    mutationFn: () =>
      api<{ transferred: number }>(`/api/admin/users/${user.id}/notes/transfer`, {
        method: 'POST',
        body: { toUserId: Number(toUserId) },
      }),
    onSuccess: (res) => {
      setDone(res.transferred);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'notes-count'] });
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not transfer the notes'),
  });

  // Notes handed to a deactivated account would be unreachable all over again.
  const candidates = users.filter((u) => u.id !== user.id && u.isActive);
  const count = countData?.count;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setDone(null);
          setError(null);
          setToUserId('');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Transfer notes
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer {user.displayName}’s notes</DialogTitle>
        </DialogHeader>

        {done !== null ? (
          <div className="grid gap-3">
            <p className="text-sm">
              {done === 0 ? 'That account had no notes.' : `Moved ${done} note(s).`}
            </p>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </div>
        ) : (
          <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">
              Notes are private to their owner, so when someone leaves theirs become unreachable —
              and deleting the account would remove them entirely. This moves them to a colleague.
              It does not let you read them.
            </p>
            <p className="text-sm">
              {count === undefined ? 'Counting…' : `${count} note(s) will move.`}
            </p>
            <Select value={toUserId} onValueChange={setToUserId}>
              <SelectTrigger aria-label="New owner">
                <SelectValue placeholder="New owner" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.displayName} ({u.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <Button
              disabled={!toUserId || transfer.isPending || count === 0}
              onClick={() => transfer.mutate()}
            >
              {transfer.isPending ? 'Moving…' : 'Transfer ownership'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
