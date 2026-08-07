import { useEffect, useRef } from 'react';
import { dropTargetForElements } from './dnd';
import { TaskCard, type TaskCardData } from './TaskCard';

export function BoardColumn({
  column,
  tasks,
  onOpenTask,
}: {
  column: { id: number; name: string };
  tasks: TaskCardData[];
  onOpenTask: (id: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => source.data.type === 'task',
      getData: () => ({ type: 'column', columnId: column.id }),
    });
  }, [column.id]);

  return (
    <div className="flex w-[85vw] shrink-0 snap-start flex-col rounded-md bg-muted/40 p-2 md:w-72">
      <h3 className="mb-2 px-1 text-sm font-semibold text-muted-foreground">{column.name}</h3>
      <div ref={ref} className="flex flex-1 flex-col gap-2">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} onOpen={onOpenTask} />
        ))}
        {tasks.length === 0 && (
          <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            No tasks — add one above or drag a card here
          </p>
        )}
      </div>
    </div>
  );
}
