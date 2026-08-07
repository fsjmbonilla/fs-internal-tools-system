import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuthStore } from '@/features/auth/authStore';
import { api } from '@/lib/api';
import { TransferNotesDialog } from './TransferNotesDialog';

interface AdminUser {
  id: number;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  isActive: boolean;
  createdAt: string;
}

export function UsersTab() {
  const queryClient = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<{ users: AdminUser[] }>('/api/admin/users'),
  });

  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: number; role?: 'admin' | 'member'; isActive?: boolean }) =>
      api(`/api/admin/users/${id}`, { method: 'PATCH', body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="grid gap-2 pt-6" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-11 animate-pulse rounded bg-muted" />
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {/* Table ships its own overflow-x-auto container — wide rows scroll here, not the page. */}
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.users.map((u) => {
              const self = u.id === me?.id;
              return (
                <TableRow key={u.id}>
                  <TableCell>{u.displayName}</TableCell>
                  <TableCell className="text-muted-foreground">{u.email}</TableCell>
                  <TableCell>
                    <Select
                      value={u.role}
                      disabled={self || patch.isPending}
                      onValueChange={(role) =>
                        patch.mutate({ id: u.id, role: role as 'admin' | 'member' })
                      }
                    >
                      <SelectTrigger className="min-h-11 w-28 md:min-h-8" aria-label="Role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">admin</SelectItem>
                        <SelectItem value="member">member</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={`${u.displayName} active`}
                      checked={u.isActive}
                      disabled={self || patch.isPending}
                      onCheckedChange={(isActive) => patch.mutate({ id: u.id, isActive })}
                    />
                  </TableCell>
                  <TableCell>
                    {/* Offboarding: a departing colleague's notes are private and
                        would otherwise be unreachable. Not offered for yourself. */}
                    {!self && <TransferNotesDialog user={u} users={data?.users ?? []} />}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
