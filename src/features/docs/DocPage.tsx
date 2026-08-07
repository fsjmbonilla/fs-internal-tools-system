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
  const { data, isError, refetch } = useQuery({
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

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <p className="text-sm text-muted-foreground">This document could not be loaded.</p>
        <Button variant="outline" size="sm" className="min-h-11 md:min-h-7" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="h-full p-4" aria-hidden="true">
        <div className="mb-4 h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="space-y-2">
          <div className="h-4 w-full animate-pulse rounded bg-muted" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-4 animate-in fade-in">
      {attachError && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {attachError}
        </p>
      )}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 truncate font-semibold">{data.doc.title}</h2>
        <div className="flex items-center gap-2">
          {canEdit && (
          <button
            type="button"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 md:min-h-8 md:min-w-8"
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
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-7"
            onClick={() => setPreview((v) => !v)}
          >
            {preview ? 'Edit' : 'Preview'}
          </Button>
          {canEdit && (
            <Button
              size="sm"
              className="min-h-11 md:min-h-7"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save'}
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
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Markdown content={content} />
        </div>
      ) : (
        <textarea
          className="min-h-0 flex-1 resize-none rounded-md border bg-background p-3 font-mono text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      )}
    </div>
  );
}
