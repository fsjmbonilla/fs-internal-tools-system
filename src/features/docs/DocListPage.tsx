import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

interface Doc {
  id: number;
  title: string;
}

export function DocListPage() {
  const { projectId } = useParams();
  const id = Number(projectId);
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const { data } = useQuery({
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
    <div className="p-4">
      <div className="mb-3 flex gap-2">
        <Input placeholder="New doc title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Button disabled={!title.trim() || create.isPending} onClick={() => create.mutate()}>
          Add
        </Button>
      </div>
      <ul className="grid gap-1">
        {data?.docs.map((d) => (
          <li key={d.id}>
            <Link className="text-sm underline" to={`/projects/${id}/docs/${d.id}`}>
              {d.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
