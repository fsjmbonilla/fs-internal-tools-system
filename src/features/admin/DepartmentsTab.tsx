import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import type { PublicUser } from '@/features/auth/authStore';

interface Department {
  id: number;
  name: string;
  description: string | null;
  members: { userId: number; role: 'lead' | 'member' }[];
}

export function DepartmentsTab() {
  const queryClient = useQueryClient();
  const { data: deptData, isLoading } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api<{ departments: Department[] }>('/api/departments'),
  });
  const { data: userData } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ users: PublicUser[] }>('/api/users'),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['departments'] });

  const create = useMutation({
    mutationFn: (body: { name: string; description?: string }) =>
      api('/api/departments', { method: 'POST', body }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/departments/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
  const addMember = useMutation({
    mutationFn: ({ deptId, userId, role }: { deptId: number; userId: number; role: 'lead' | 'member' }) =>
      api(`/api/departments/${deptId}/members`, { method: 'POST', body: { userId, role } }),
    onSuccess: invalidate,
  });
  const removeMember = useMutation({
    mutationFn: ({ deptId, userId }: { deptId: number; userId: number }) =>
      api(`/api/departments/${deptId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [pickUser, setPickUser] = useState<string>('');
  const [pickRole, setPickRole] = useState<'lead' | 'member'>('member');

  const userName = (id: number) =>
    userData?.users.find((u) => u.id === id)?.displayName ?? `#${id}`;

  return (
    <div className="grid gap-4">
      <div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="min-h-11 md:min-h-8">New department</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create department</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="dept-name">Name</Label>
                <Input id="dept-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="dept-desc">Description (optional)</Label>
                <Input
                  id="dept-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <Button
                className="min-h-11 md:min-h-8"
                disabled={!name.trim() || create.isPending}
                onClick={() =>
                  create.mutate(
                    { name: name.trim(), description: description.trim() || undefined },
                    {
                      onSuccess: () => {
                        setName('');
                        setDescription('');
                        setCreateOpen(false);
                      },
                    },
                  )
                }
              >
                {create.isPending ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading && (
        <div className="grid gap-4" aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      )}

      {deptData?.departments.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No departments yet — create the first one with New department.
        </p>
      )}

      {deptData?.departments.map((d) => (
        <Card key={d.id}>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="min-w-0 text-lg">
              {d.name}
              {d.description && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {d.description}
                </span>
              )}
            </CardTitle>
            <Button
              variant="destructive"
              size="sm"
              className="min-h-11 shrink-0 md:min-h-7"
              disabled={remove.isPending}
              onClick={() => {
                if (confirm(`Delete department "${d.name}"?`)) remove.mutate(d.id);
              }}
            >
              {remove.isPending && remove.variables === d.id ? 'Deleting…' : 'Delete'}
            </Button>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              {d.members.length === 0 && (
                <span className="text-sm text-muted-foreground">No members yet</span>
              )}
              {d.members.map((m) => (
                <Badge key={m.userId} variant={m.role === 'lead' ? 'default' : 'secondary'}>
                  {userName(m.userId)}
                  {m.role === 'lead' ? ' (lead)' : ''}
                  <button
                    type="button"
                    aria-label={`remove ${userName(m.userId)}`}
                    className="ml-0.5 -mr-1 rounded px-1.5 py-1 opacity-60 transition-opacity hover:opacity-100"
                    onClick={() => removeMember.mutate({ deptId: d.id, userId: m.userId })}
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={pickUser} onValueChange={setPickUser}>
                <SelectTrigger className="min-h-11 w-full md:min-h-8 sm:w-52">
                  <SelectValue placeholder="Add member…" />
                </SelectTrigger>
                <SelectContent>
                  {userData?.users
                    .filter((u) => !d.members.some((m) => m.userId === u.id))
                    .map((u) => (
                      <SelectItem key={u.id} value={String(u.id)}>
                        {u.displayName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Select value={pickRole} onValueChange={(v) => setPickRole(v as 'lead' | 'member')}>
                <SelectTrigger className="min-h-11 w-32 md:min-h-8" aria-label="Role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">member</SelectItem>
                  <SelectItem value="lead">lead</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="secondary"
                className="min-h-11 md:min-h-8"
                disabled={!pickUser || addMember.isPending}
                onClick={() =>
                  addMember.mutate(
                    { deptId: d.id, userId: Number(pickUser), role: pickRole },
                    { onSuccess: () => setPickUser('') },
                  )
                }
              >
                {addMember.isPending ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
