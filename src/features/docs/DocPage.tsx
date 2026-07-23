import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { AttachmentChip, type AttachmentInfo } from '@/features/files/AttachmentChip';
import { api } from '@/lib/api';
import { uploadFiles } from '@/lib/uploads';
import { Markdown } from './Markdown';

interface Doc {
  id: number;
  projectId: number;
  title: string;
  content: string;
  attachments: AttachmentInfo[];
}

export function DocPage() {
  const { docId } = useParams();
  const id = Number(docId);
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  const attach = useMutation({
    mutationFn: async (files: File[]) => {
      const uploaded = await uploadFiles(files);
      return api(`/api/docs/${id}/attachments`, {
        method: 'POST',
        body: { attachmentIds: uploaded.map((f) => f.id) },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['doc', id] }),
  });

  if (!data) return null;

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">{data.doc.title}</h2>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent disabled:opacity-50"
            disabled={attach.isPending}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach file"
          >
            <Paperclip className="size-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) attach.mutate(files);
            }}
          />
          <Button variant="outline" size="sm" onClick={() => setPreview((v) => !v)}>
            {preview ? 'Edit' : 'Preview'}
          </Button>
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      </div>
      {data.doc.attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {data.doc.attachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} />
          ))}
        </div>
      )}
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
