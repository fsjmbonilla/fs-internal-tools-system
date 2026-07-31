import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { listProjects } from '@/features/projects/api';
import { ApiError } from '@/lib/api';
import { createSupportChannel } from './api';

export function NewSupportChannelDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState<number | null>(null);
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['projects'], queryFn: listProjects, enabled: open });

  async function handleCreate() {
    setError(null);
    if (!name.trim() || projectId === null) {
      setError('Pick a name and a target project.');
      return;
    }
    try {
      await createSupportChannel({
        name: name.trim(),
        isPrivate: false,
        projectId,
        instructions: instructions.trim() || undefined,
      });
      setName('');
      setInstructions('');
      setProjectId(null);
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create support channel');
    }
  }

  if (!open) return null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New support channel</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <input
            className="rounded-md border px-2 py-1 text-sm"
            placeholder="Channel name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            className="rounded-md border px-2 py-1 text-sm"
            value={projectId ?? ''}
            onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select target project…</option>
            {data?.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <textarea
            className="rounded-md border px-2 py-1 text-sm"
            rows={3}
            placeholder="Optional extra guidance for the assistant"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            onClick={handleCreate}
          >
            Create
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
