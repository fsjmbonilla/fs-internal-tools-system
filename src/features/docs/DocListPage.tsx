import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useProjectMembership } from '@/features/projects/useProjectMembership';

interface Doc {
  id: number;
  title: string;
}

export function DocListPage() {
  const { projectId } = useParams();
  const id = Number(projectId);
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const { canEdit } = useProjectMembership(id);
  const { data, isLoading } = useQuery({
    queryKey: ['docs', id],
    queryFn: () => api<{ docs: Doc[] }>(`/api/projects/${id}/docs`),
    enabled: Number.isFinite(id),
  });

  const create = useMutation({
    mutationFn: () => api(`/api/projects/${id}/docs`, { method: 'POST', body: { title, content: '' } }),
    onSuccess: () => {
      setTitle('');
      queryClient.invalidateQueries({ queryKey: ['docs', id] });
    },
  });

  return (
    <div className="h-full overflow-y-auto p-4 animate-in fade-in">
      {canEdit && (
      <form
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() && !create.isPending) create.mutate();
        }}
      >
        <Input placeholder="New doc title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Button type="submit" className="min-h-11 md:min-h-8" disabled={!title.trim() || create.isPending}>
          {create.isPending ? 'Adding…' : 'Add'}
        </Button>
      </form>
      )}
      {isLoading && (
        <div className="space-y-1" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-11 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      )}
      {!isLoading && data?.docs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {canEdit
            ? 'No documents in this project yet — add the first one above.'
            : 'No documents in this project yet.'}
        </p>
      )}
      <ul className="grid gap-1">
        {data?.docs.map((d) => (
          <li key={d.id}>
            <Link
              className="flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-accent"
              to={`/projects/${id}/docs/${d.id}`}
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{d.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
