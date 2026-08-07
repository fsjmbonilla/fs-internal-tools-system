import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useProjectMembership } from '@/features/projects/useProjectMembership';
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
  const { canEdit } = useProjectMembership(id);

  useEffect(() => {
    return monitorForElements({
      onDrop({ source, location }) {
        const destination = location.current.dropTargets[0];
        if (!destination || source.data.type !== 'task') return;
        // Non-members can read the board but not rearrange it; without this the
        // card would snap to its new column and then bounce back on a 403.
        if (!canEdit) return;
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
  }, [id, queryClient, canEdit]);

  if (!data) {
    // Skeleton shaped like the board: a nav strip and three columns.
    return (
      <div className="flex h-full flex-col p-4">
        <div className="mb-3 h-5 w-48 animate-pulse rounded bg-muted" />
        <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-64 w-[85vw] shrink-0 animate-pulse rounded-md bg-muted md:w-72" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-4 animate-in fade-in duration-150">
      {/* The project's other surfaces. Docs and sheets predate this strip and
          were reachable only via the quick-switcher; Files (Drive) arrives with
          Phase 13 and needs a visible way in. */}
      <nav className="mb-3 flex items-center gap-3 text-sm">
        <span className="flex min-h-11 items-center font-medium md:min-h-0">Board</span>
        <Link
          to={`/projects/${id}/docs`}
          className="flex min-h-11 items-center text-muted-foreground transition-colors hover:text-foreground hover:underline md:min-h-0"
        >
          Docs
        </Link>
        <Link
          to={`/projects/${id}/sheets`}
          className="flex min-h-11 items-center text-muted-foreground transition-colors hover:text-foreground hover:underline md:min-h-0"
        >
          Sheets
        </Link>
        <Link
          to={`/projects/${id}/files`}
          className="flex min-h-11 items-center text-muted-foreground transition-colors hover:text-foreground hover:underline md:min-h-0"
        >
          Files
        </Link>
      </nav>
      {canEdit && (
      <div className="mb-3 flex gap-2">
        <Input
          className="min-h-11 md:min-h-8"
          placeholder="New task title"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <Button
          className="min-h-11 md:min-h-8"
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
      )}
      {/* The only horizontal scroller on the page; on phones each column snaps
          to fill the viewport, on md+ columns take their fixed width. */}
      <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:snap-none">
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
