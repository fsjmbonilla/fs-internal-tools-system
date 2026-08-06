import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { listChannels } from '@/features/chat/api';
import {
  createRoutine,
  deleteRoutine,
  describeSchedule,
  listRoutineRuns,
  listRoutines,
  runRoutineNow,
  SCHEDULE_PRESETS,
  SCOPES,
  updateRoutine,
  type Routine,
  type RoutineRun,
  type Scope,
  type TranscriptEntry,
} from './api';

/**
 * AI Routines.
 *
 * The transcript viewer is the point of this screen. A routine acts when nobody
 * is looking, so the only way to trust one is to read what it actually did —
 * every tool call and every result, in order.
 */
export function RoutinesPage() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['routines'], queryFn: listRoutines });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['routines'] });

  const selected = data?.routines.find((r) => r.id === selectedId) ?? null;

  const create = useMutation({
    mutationFn: () =>
      createRoutine({
        name: 'New routine',
        prompt: 'Describe what this routine should do each time it runs.',
        schedule: '0 8 * * 1-5',
        scopes: [],
      }),
    onSuccess: (res) => {
      invalidate();
      setSelectedId(res.routine.id);
    },
  });

  return (
    <div className="flex h-full">
      <div className="w-72 shrink-0 border-r p-2">
        <div className="mb-2 flex items-center gap-2">
          <h1 className="mr-auto text-sm font-semibold">Routines</h1>
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
            New
          </Button>
        </div>
        <ul className="grid gap-1">
          {data?.routines.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setSelectedId(r.id)}
                className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${
                  selectedId === r.id ? 'bg-muted' : ''
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${r.enabled ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                    title={r.enabled ? 'Enabled' : 'Disabled'}
                  />
                  <span className="truncate">{r.name}</span>
                </span>
                <span className="block pl-4 text-xs text-muted-foreground">
                  {describeSchedule(r.schedule)}
                  {r.nextRunAt && ` · next ${new Date(r.nextRunAt).toLocaleTimeString()}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {data?.routines.length === 0 && (
          <p className="text-xs text-muted-foreground">No routines yet.</p>
        )}
      </div>

      <div className="min-w-0 flex-1 overflow-auto p-3">
        {selected ? (
          <RoutineEditor
            key={selected.id}
            routine={selected}
            onChanged={invalidate}
            onDeleted={() => {
              setSelectedId(null);
              invalidate();
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Select a routine, or create one. A routine runs on a schedule with only the scopes you
            grant it, and every run keeps a transcript of what it did.
          </p>
        )}
      </div>
    </div>
  );
}

function RoutineEditor({
  routine,
  onChanged,
  onDeleted,
}: {
  routine: Routine;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(routine.name);
  const [prompt, setPrompt] = useState(routine.prompt);
  const [schedule, setSchedule] = useState(routine.schedule);
  const [scopes, setScopes] = useState<Scope[]>(routine.scopes);
  const [channelId, setChannelId] = useState<number | null>(routine.outputChannelId);
  const [error, setError] = useState<string | null>(null);

  const { data: channelData } = useQuery({ queryKey: ['channels'], queryFn: listChannels });
  const runsQuery = useQuery({
    queryKey: ['routine-runs', routine.id],
    queryFn: () => listRoutineRuns(routine.id),
  });

  const save = useMutation({
    mutationFn: () =>
      updateRoutine(routine.id, {
        name: name.trim() || 'Untitled',
        prompt,
        schedule,
        scopes,
        outputChannelId: channelId,
      }),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Could not save'),
  });

  const toggle = useMutation({
    mutationFn: () => updateRoutine(routine.id, { enabled: !routine.enabled }),
    onSuccess: onChanged,
  });

  const runNow = useMutation({
    mutationFn: () => runRoutineNow(routine.id),
    onSuccess: () => {
      void runsQuery.refetch();
      onChanged();
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Could not run'),
  });

  const remove = useMutation({ mutationFn: () => deleteRoutine(routine.id), onSuccess: onDeleted });

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-72"
          value={name}
          aria-label="Routine name"
          onChange={(e) => setName(e.target.value)}
        />
        <span className="mr-auto text-xs text-muted-foreground">
          {routine.enabled ? `Next run ${routine.nextRunAt ? new Date(routine.nextRunAt).toLocaleString() : '—'}` : 'Disabled'}
        </span>
        <Button size="sm" variant="outline" onClick={() => toggle.mutate()}>
          {routine.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" disabled={runNow.isPending} onClick={() => runNow.mutate()}>
          {runNow.isPending ? 'Running…' : 'Run now'}
        </Button>
        <Button size="sm" variant="destructive" onClick={() => remove.mutate()}>
          Delete
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <label className="grid gap-1 text-xs font-medium">
        What should it do?
        <textarea
          className="min-h-28 rounded border bg-background p-2 text-sm font-normal"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>

      <div className="flex flex-wrap gap-4">
        <label className="grid gap-1 text-xs font-medium">
          Schedule
          <select
            className="rounded border px-2 py-1 text-sm font-normal"
            value={SCHEDULE_PRESETS.some((p) => p.value === schedule) ? schedule : 'custom'}
            onChange={(e) => e.target.value !== 'custom' && setSchedule(e.target.value)}
          >
            {SCHEDULE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium">
          Cron expression
          <Input className="w-44 font-mono" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
        </label>

        <label className="grid gap-1 text-xs font-medium">
          Post its summary to
          <select
            className="rounded border px-2 py-1 text-sm font-normal"
            value={channelId ?? ''}
            onChange={(e) => setChannelId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Nowhere — just keep the transcript</option>
            {channelData?.channels
              .filter((c) => c.type !== 'dm')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  # {c.name}
                </option>
              ))}
          </select>
        </label>
      </div>

      <fieldset className="rounded border p-2">
        <legend className="px-1 text-xs font-medium">Tools this routine may use</legend>
        <div className="flex flex-wrap gap-3">
          {SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={() =>
                  setScopes((current) =>
                    current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
                  )
                }
              />
              <code>{scope}</code>
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          A routine is offered only the tools its scopes allow. Its prompt cannot talk past this.
        </p>
      </fieldset>

      <RunHistory runs={runsQuery.data?.runs ?? []} />
    </div>
  );
}

const STATUS_STYLE: Record<RoutineRun['status'], string> = {
  running: 'bg-blue-100 text-blue-900',
  succeeded: 'bg-green-100 text-green-900',
  failed: 'bg-red-100 text-red-900',
  // Not a failure: the routine worked and ran out of its allowance.
  budget_exceeded: 'bg-amber-100 text-amber-900',
};

function RunHistory({ runs }: { runs: RoutineRun[] }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const open = runs.find((r) => r.id === openId) ?? runs[0];

  if (runs.length === 0) return <p className="text-xs text-muted-foreground">No runs yet.</p>;

  return (
    <div className="rounded border p-2">
      <div className="mb-2 flex flex-wrap gap-1">
        {runs.slice(0, 15).map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setOpenId(r.id)}
            className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[r.status]} ${
              open?.id === r.id ? 'ring-1 ring-foreground/30' : ''
            }`}
            title={new Date(r.startedAt).toLocaleString()}
          >
            #{r.id} {r.status.replace('_', ' ')} · {r.trigger}
          </button>
        ))}
      </div>

      {open && (
        <div className="grid gap-2 text-xs">
          <p className="text-muted-foreground">
            {open.iterations} step{open.iterations === 1 ? '' : 's'} ·{' '}
            {open.inputTokens + open.outputTokens} tokens
            {open.finishedAt && ` · finished ${new Date(open.finishedAt).toLocaleTimeString()}`}
          </p>
          {open.error && <p className="text-destructive">{open.error}</p>}
          {open.summary && <p className="rounded bg-muted p-2">{open.summary}</p>}
          <Transcript entries={open.transcript ?? []} />
        </div>
      )}
    </div>
  );
}

/** What the routine did, in order — the reason to trust an unattended run. */
function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <ol className="grid gap-1">
      {entries.map((entry, index) => (
        // Transcript entries have no ids and never reorder — index is the key.
        <li key={index} className="rounded border-l-2 border-muted pl-2">
          {entry.type === 'text' && <p className="whitespace-pre-wrap">{entry.text}</p>}
          {entry.type === 'tool_use' && (
            <p>
              <span className="font-medium">called</span> <code>{entry.name}</code>{' '}
              <code className="text-muted-foreground">{JSON.stringify(entry.input)}</code>
            </p>
          )}
          {entry.type === 'tool_result' && (
            <pre className="overflow-x-auto whitespace-pre-wrap text-muted-foreground">
              → {JSON.stringify(entry.output).slice(0, 400)}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}
