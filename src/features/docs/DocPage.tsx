import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { AttachmentChip, type AttachmentInfo } from '@/features/files/AttachmentChip';
import { api } from '@/lib/api';
import { rejectionMessage, uploadFiles } from '@/lib/uploads';
import { useProjectMembership } from '@/features/projects/useProjectMembership';
import { Markdown } from './Markdown';

interface Doc {
  id: number;
  projectId: number;
  title: string;
  content: string;
  attachments: AttachmentInfo[];
}

export function DocPage() {
  const { docId, projectId } = useParams();
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
  const [attachError, setAttachError] = useState<string | null>(null);
  // The doc carries its project id, so membership is resolved from that.
  const { canEdit } = useProjectMembership(Number(projectId));

  useEffect(() => {
    if (data) setContent(data.doc.content);
  }, [data]);

  const save = useMutation({
    mutationFn: () => api(`/api/docs/${id}`, { method: 'PATCH', body: { content } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['doc', id] }),
  });

  const attach = useMutation({
    mutationFn: async (files: File[]) => {
      const { attachments, rejected } = await uploadFiles(files);
      // Refused files get no row and no chip; the caller shows this instead of
      // letting them look like they silently vanished.
      setAttachError(rejectionMessage(rejected));
      if (attachments.length === 0) return null;
      return api(`/api/docs/${id}/attachments`, {
        method: 'POST',
        body: { attachmentIds: attachments.map((f) => f.id) },
      });
    },
    onError: (err: unknown) =>
      setAttachError(err instanceof Error ? err.message : 'Upload failed'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['doc', id] }),
  });

  if (!data) return null;

  return (
    <div className="flex h-full flex-col p-4">
      {attachError && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {attachError}
        </p>
      )}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">{data.doc.title}</h2>
        <div className="flex gap-2">
          {canEdit && (
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent disabled:opacity-50"
            disabled={attach.isPending}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach file"
          >
            <Paperclip className="size-4" />
          </button>
          )}
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
          {canEdit && (
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          )}
        </div>
      </div>
      {data.doc.attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {data.doc.attachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} />
          ))}
        </div>
      )}
      {preview || !canEdit ? (
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
