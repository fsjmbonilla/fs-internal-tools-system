import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';

interface Task {
  id: number;
  title: string;
  description: string | null;
  assigneeId: number | null;
  dueDate: string | null;
}

interface Comment {
  id: number;
  displayName: string;
  body: string;
  createdAt: string;
}

export function TaskDetailSheet({ taskId, onClose }: { taskId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
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
