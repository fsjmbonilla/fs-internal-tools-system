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
  const { data } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<{ users: AdminUser[] }>('/api/admin/users'),
  });

  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: number; role?: 'admin' | 'member'; isActive?: boolean }) =>
      api(`/api/admin/users/${id}`, { method: 'PATCH', body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Active</TableHead>
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
                      <SelectTrigger className="w-28">
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
                      checked={u.isActive}
                      disabled={self || patch.isPending}
                      onCheckedChange={(isActive) => patch.mutate({ id: u.id, isActive })}
                    />
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
