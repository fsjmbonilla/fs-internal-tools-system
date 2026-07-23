import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { BoardColumn } from './BoardColumn';
import { extractClosestEdge, monitorForElements } from './dnd';
import { TaskDetailSheet } from './TaskDetailSheet';
import type { TaskCardData } from './TaskCard';

interface Column {
  id: number;
  name: string;
  position: number;
}

interface Board {
  columns: Column[];
  tasks: TaskCardData[];
}

export function ProjectBoardPage() {
  const { projectId } = useParams();
  const id = Number(projectId);
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['board', id],
    queryFn: () => api<Board>(`/api/projects/${id}/board`),
    enabled: Number.isFinite(id),
  });
  const [newTitle, setNewTitle] = useState('');
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);

  useEffect(() => {
    return monitorForElements({
      onDrop({ source, location }) {
        const destination = location.current.dropTargets[0];
        if (!destination || source.data.type !== 'task') return;
        const taskId = source.data.taskId as number;
        const destData = destination.data as { type: string; columnId: number; taskId?: number };
        const columnId = destData.columnId;

        queryClient.setQueryData<Board>(['board', id], (old) => {
          if (!old) return old;
          const others = old.tasks.filter((t) => t.id !== taskId);
          const moved = old.tasks.find((t) => t.id === taskId);
          if (!moved) return old;
          return { ...old, tasks: [...others, { ...moved, columnId }] };
        });

        let beforeTaskId: number | undefined;
        let afterTaskId: number | undefined;
        if (destData.type === 'task' && destData.taskId) {
          const edge = extractClosestEdge(destination.data);
          if (edge === 'top') afterTaskId = destData.taskId;
          else beforeTaskId = destData.taskId;
        }

        void api(`/api/tasks/${taskId}/move`, {
          method: 'POST',
          body: { columnId, beforeTaskId, afterTaskId },
        }).then(() => queryClient.invalidateQueries({ queryKey: ['board', id] }));
      },
    });
  }, [id, queryClient]);

  if (!data) return null;

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex gap-2">
        <Input
          placeholder="New task title"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <Button
          disabled={!newTitle.trim()}
          onClick={async () => {
            await api(`/api/projects/${id}/tasks`, {
              method: 'POST',
              body: { columnId: data.columns[0].id, title: newTitle.trim() },
            });
            setNewTitle('');
            queryClient.invalidateQueries({ queryKey: ['board', id] });
          }}
        >
          Add task
        </Button>
      </div>
      <div className="flex flex-1 gap-3 overflow-x-auto">
        {data.columns.map((c) => (
          <BoardColumn
            key={c.id}
            column={c}
            tasks={data.tasks.filter((t) => t.columnId === c.id)}
            onOpenTask={setOpenTaskId}
          />
        ))}
      </div>
      {openTaskId && <TaskDetailSheet taskId={openTaskId} onClose={() => setOpenTaskId(null)} />}
    </div>
  );
}
