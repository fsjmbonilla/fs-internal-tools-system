import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
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
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({ queryKey: ['projects'], queryFn: listProjects, enabled: open });

  // Stable ids so every control has a real <label> pointing at it.
  const fieldId = useId();
  const nameId = `${fieldId}-name`;
  const projectIdId = `${fieldId}-project`;
  const instructionsId = `${fieldId}-instructions`;

  async function handleCreate() {
    // A second click while the first request is in flight created a second channel.
    if (busy) return;
    setError(null);
    if (!name.trim() || projectId === null) {
      setError('Pick a name and a target project.');
      return;
    }
    setBusy(true);
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
    } finally {
      setBusy(false);
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
          <div className="flex flex-col gap-1">
            <label htmlFor={nameId} className="text-xs font-medium">
              Channel name
            </label>
            <input
              id={nameId}
              className="rounded-md border px-2 py-1 text-sm"
              placeholder="e.g. it-help"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={projectIdId} className="text-xs font-medium">
              File tickets into
            </label>
            <select
              id={projectIdId}
              className="rounded-md border px-2 py-1 text-sm"
              value={projectId ?? ''}
              disabled={busy}
              onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select target project…</option>
              {data?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={instructionsId} className="text-xs font-medium">
              Extra guidance for the assistant <span className="font-normal">(optional)</span>
            </label>
            <textarea
              id={instructionsId}
              className="rounded-md border px-2 py-1 text-sm"
              rows={3}
              placeholder="e.g. Escalate anything about payroll."
              value={instructions}
              disabled={busy}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>
          {error && (
            <p className="text-xs text-red-600" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-60"
            onClick={handleCreate}
            disabled={busy}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
