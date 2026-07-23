import { useEffect, useRef, useState } from 'react';
import {
  attachClosestEdge,
  combine,
  draggable,
  dropTargetForElements,
  type Edge,
  extractClosestEdge,
} from './dnd';

export interface TaskCardData {
  id: number;
  columnId: number;
  title: string;
  assigneeId: number | null;
  dueDate: string | null;
}

export function TaskCard({ task, onOpen }: { task: TaskCardData; onOpen: (id: number) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return combine(
      draggable({
        element: el,
        getInitialData: () => ({ type: 'task', taskId: task.id, columnId: task.columnId }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => source.data.type === 'task' && source.data.taskId !== task.id,
        getData: ({ input, element }) =>
          attachClosestEdge(
            { type: 'task', taskId: task.id, columnId: task.columnId },
            { input, element, allowedEdges: ['top', 'bottom'] },
          ),
        onDragEnter: (args) => setClosestEdge(extractClosestEdge(args.self.data)),
        onDrag: (args) => setClosestEdge(extractClosestEdge(args.self.data)),
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      }),
    );
  }, [task.id, task.columnId]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen(task.id)}
      className={`relative w-full rounded-md border bg-card p-2 text-left text-sm shadow-sm ${
        dragging ? 'opacity-40' : ''
      }`}
    >
      {closestEdge === 'top' && <div className="absolute inset-x-0 -top-1 h-0.5 bg-primary" />}
      {task.title}
      {task.dueDate && <div className="mt-1 text-xs text-muted-foreground">{task.dueDate}</div>}
      {closestEdge === 'bottom' && <div className="absolute inset-x-0 -bottom-1 h-0.5 bg-primary" />}
    </button>
  );
}
