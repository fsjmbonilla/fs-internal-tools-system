import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { Markdown } from './Markdown';

interface Doc {
  id: number;
  projectId: number;
  title: string;
  content: string;
}

export function DocPage() {
  const { docId } = useParams();
  const id = Number(docId);
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['doc', id],
    queryFn: () => api<{ doc: Doc }>(`/api/docs/${id}`),
    enabled: Number.isFinite(id),
  });
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (data) setContent(data.doc.content);
  }, [data]);

  const save = useMutation({
    mutationFn: () => api(`/api/docs/${id}`, { method: 'PATCH', body: { content } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['doc', id] }),
  });

  if (!data) return null;

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">{data.doc.title}</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setPreview((v) => !v)}>
            {preview ? 'Edit' : 'Preview'}
          </Button>
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      </div>
      {preview ? (
        <Markdown content={content} />
      ) : (
        <textarea
          className="flex-1 resize-none rounded-md border bg-background p-3 font-mono text-sm outline-none"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      )}
    </div>
  );
}
