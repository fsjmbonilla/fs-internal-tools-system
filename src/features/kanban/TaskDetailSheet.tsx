import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { AttachmentChip, type AttachmentInfo } from '@/features/files/AttachmentChip';
import { api } from '@/lib/api';
import { uploadFiles } from '@/lib/uploads';

interface Task {
  id: number;
  title: string;
  description: string | null;
  assigneeId: number | null;
  dueDate: string | null;
  attachments: AttachmentInfo[];
}

interface Comment {
  id: number;
  displayName: string;
  body: string;
  createdAt: string;
}

export function TaskDetailSheet({ taskId, onClose }: { taskId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: task } = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api<{ task: Task }>(`/api/tasks/${taskId}`),
  });
  const { data: commentsData } = useQuery({
    queryKey: ['task-comments', taskId],
    queryFn: () => api<{ comments: Comment[] }>(`/api/tasks/${taskId}/comments`),
  });
  const [comment, setComment] = useState('');

  const addComment = useMutation({
    mutationFn: () => api(`/api/tasks/${taskId}/comments`, { method: 'POST', body: { body: comment } }),
    onSuccess: () => {
      setComment('');
      queryClient.invalidateQueries({ queryKey: ['task-comments', taskId] });
    },
  });

  const attach = useMutation({
    mutationFn: async (files: File[]) => {
      const uploaded = await uploadFiles(files);
      return api(`/api/tasks/${taskId}/attachments`, {
        method: 'POST',
        body: { attachmentIds: uploaded.map((f) => f.id) },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['task', taskId] }),
  });

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{task?.task.title}</SheetTitle>
        </SheetHeader>
        <div className="grid gap-4 p-4">
          {task?.task.description && <p className="text-sm">{task.task.description}</p>}
          {task?.task.dueDate && <p className="text-xs text-muted-foreground">Due {task.task.dueDate}</p>}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold">Attachments</h4>
              <button
                type="button"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent disabled:opacity-50"
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
            </div>
            <div className="flex flex-wrap gap-1">
              {task?.task.attachments.map((a) => (
                <AttachmentChip key={a.id} attachment={a} />
              ))}
            </div>
          </div>
          <div>
            <h4 className="mb-2 text-sm font-semibold">Comments</h4>
            <div className="grid gap-2">
              {commentsData?.comments.map((c) => (
                <div key={c.id} className="text-sm">
                  <span className="font-medium">{c.displayName}:</span> {c.body}
                </div>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
              <Button disabled={!comment.trim() || addComment.isPending} onClick={() => addComment.mutate()}>
                Post
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
