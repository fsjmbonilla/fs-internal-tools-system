import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, FileCode2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { listChannels } from '@/features/chat/api';
import { listDriveFiles } from '@/features/drive/api';
import { DriveBrowser } from '@/features/drive/DriveBrowser';
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
  type RoutineKind,
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
  const { data, isLoading } = useQuery({ queryKey: ['routines'], queryFn: listRoutines });
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
      {/* < md: one pane at a time — the list hides once a routine is open. */}
      <div
        className={`w-full shrink-0 overflow-y-auto p-2 md:block md:w-72 md:border-r ${
          selected ? 'hidden' : ''
        }`}
      >
        <div className="mb-2 flex items-center gap-2">
          <h1 className="mr-auto text-sm font-semibold">Routines</h1>
          <Button
            size="sm"
            className="min-h-11 md:min-h-7"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'New'}
          </Button>
        </div>
        {isLoading && (
          <div className="grid gap-1" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-muted" />
            ))}
          </div>
        )}
        <ul className="grid gap-1">
          {data?.routines.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setSelectedId(r.id)}
                className={`min-h-11 w-full rounded px-2 py-1 text-left text-sm transition-colors hover:bg-accent ${
                  selectedId === r.id ? 'bg-accent font-medium' : ''
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${r.enabled ? 'bg-primary' : 'bg-muted-foreground/40'}`}
                    title={r.enabled ? 'Enabled' : 'Disabled'}
                  />
                  <span className="truncate">{r.name}</span>
                </span>
                <span className="block pl-4 text-xs font-normal text-muted-foreground">
                  {describeSchedule(r.schedule)}
                  {r.nextRunAt && ` · next ${new Date(r.nextRunAt).toLocaleTimeString()}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {data?.routines.length === 0 && (
          <p className="px-2 text-xs text-muted-foreground">
            No routines yet — press New to schedule the first one.
          </p>
        )}
      </div>

      <div
        className={`min-w-0 flex-1 overflow-y-auto p-3 ${selected ? '' : 'hidden md:block'}`}
      >
        {selected ? (
          <>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="mb-2 -ml-2 flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
            >
              <ChevronLeft className="size-4" />
              Routines
            </button>
            <RoutineEditor
              key={selected.id}
              routine={selected}
              onChanged={invalidate}
              onDeleted={() => {
                setSelectedId(null);
                invalidate();
              }}
            />
          </>
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
  const [kind, setKind] = useState<RoutineKind>(routine.kind);
  const [prompt, setPrompt] = useState(routine.prompt);
  const [schedule, setSchedule] = useState(routine.schedule);
  const [scopes, setScopes] = useState<Scope[]>(routine.scopes);
  const [scriptScopes, setScriptScopes] = useState<Scope[]>(routine.scriptScopes ?? []);
  const [driveFile, setDriveFile] = useState<{ id: string; name: string } | null>(
    routine.driveFileId
      ? { id: routine.driveFileId, name: routine.driveFileName ?? routine.driveFileId }
      : null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [channelId, setChannelId] = useState<number | null>(routine.outputChannelId);
  const [error, setError] = useState<string | null>(null);

  const { data: channelData } = useQuery({ queryKey: ['channels'], queryFn: listChannels });
  const runsQuery = useQuery({
    queryKey: ['routine-runs', routine.id],
    queryFn: () => listRoutineRuns(routine.id),
  });

  const save = useMutation({
    mutationFn: () => {
      if (kind === 'drive_script' && !driveFile) {
        return Promise.reject(new Error('Choose a script from Drive first'));
      }
      return updateRoutine(routine.id, {
        name: name.trim() || 'Untitled',
        kind,
        schedule,
        outputChannelId: channelId,
        // Only the fields the kind uses: a drive_script routine must not send
        // an empty prompt (the server rejects it), and vice versa.
        ...(kind === 'ai'
          ? { prompt, scopes }
          : {
              driveFileId: driveFile!.id,
              driveFileName: driveFile!.name,
              scriptScopes,
            }),
      });
    },
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
    <div className="grid animate-in gap-3 duration-150 fade-in">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-h-11 min-w-40 flex-1 md:min-h-8 md:max-w-72 md:flex-none"
          value={name}
          aria-label="Routine name"
          onChange={(e) => setName(e.target.value)}
        />
        <span className="mr-auto text-xs text-muted-foreground">
          {routine.enabled ? `Next run ${routine.nextRunAt ? new Date(routine.nextRunAt).toLocaleString() : '—'}` : 'Disabled'}
        </span>
        <Button
          size="sm"
          className="min-h-11 md:min-h-7"
          variant="outline"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
        >
          {toggle.isPending
            ? routine.enabled
              ? 'Disabling…'
              : 'Enabling…'
            : routine.enabled
              ? 'Disable'
              : 'Enable'}
        </Button>
        <Button
          size="sm"
          className="min-h-11 md:min-h-7"
          variant="outline"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          size="sm"
          className="min-h-11 md:min-h-7"
          disabled={runNow.isPending}
          onClick={() => runNow.mutate()}
        >
          {runNow.isPending ? 'Running…' : 'Run now'}
        </Button>
        <Button
          size="sm"
          className="min-h-11 md:min-h-7"
          variant="destructive"
          disabled={remove.isPending}
          onClick={() => {
            if (confirm(`Delete routine "${name.trim() || routine.name}"?`)) remove.mutate();
          }}
        >
          {remove.isPending ? 'Deleting…' : 'Delete'}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <label className="grid max-w-72 gap-1 text-xs font-medium">
        Kind
        <select
          className="min-h-11 rounded border bg-background px-2 py-1 text-base font-normal transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-8 md:text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value as RoutineKind)}
        >
          <option value="ai">AI prompt</option>
          <option value="drive_script">Python script from Drive</option>
        </select>
      </label>

      {kind === 'ai' ? (
        <label className="grid gap-1 text-xs font-medium">
          What should it do?
          <textarea
            className="min-h-28 rounded border bg-background p-2 text-base font-normal transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:text-sm"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
      ) : (
        <div className="grid gap-1">
          <span className="text-xs font-medium">Script to run</span>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`flex min-h-11 items-center gap-1.5 rounded border px-2 text-sm md:min-h-8 ${
                driveFile ? '' : 'text-muted-foreground'
              }`}
            >
              <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
              {driveFile ? driveFile.name : 'No script chosen yet'}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 md:min-h-8"
              onClick={() => setPickerOpen(true)}
            >
              Choose script from Drive
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The .py file is re-fetched from your Drive before every run, so edits there take
            effect on the next tick. It executes in the scripts sandbox, never in the app.
          </p>
          <ChooseScriptDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onPicked={(file) => setDriveFile(file)}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        <label className="grid gap-1 text-xs font-medium">
          Schedule
          <select
            className="min-h-11 rounded border bg-background px-2 py-1 text-base font-normal transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-8 md:text-sm"
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
          <Input
            className="min-h-11 w-44 font-mono md:min-h-8"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
          />
        </label>

        {kind === 'ai' && (
          <label className="grid gap-1 text-xs font-medium">
            Post its summary to
            <select
              className="min-h-11 rounded border bg-background px-2 py-1 text-base font-normal transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-8 md:text-sm"
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
        )}
      </div>

      {kind === 'ai' ? (
        <ScopeChecklist
          legend="Tools this routine may use"
          hint="A routine is offered only the tools its scopes allow. Its prompt cannot talk past this."
          value={scopes}
          onChange={setScopes}
        />
      ) : (
        <ScopeChecklist
          legend="Scopes the script's run token carries"
          hint="Each run gets a token holding exactly these scopes — the script cannot call past them, whatever its code does."
          value={scriptScopes}
          onChange={setScriptScopes}
        />
      )}

      {runsQuery.isLoading ? (
        <div className="h-16 animate-pulse rounded bg-muted" aria-hidden />
      ) : (
        <RunHistory runs={runsQuery.data?.runs ?? []} />
      )}
    </div>
  );
}

/** The scope checkboxes, identical UX for the AI tool scopes and the script token scopes. */
function ScopeChecklist({
  legend,
  hint,
  value,
  onChange,
}: {
  legend: string;
  hint: string;
  value: Scope[];
  onChange: (next: Scope[]) => void;
}) {
  return (
    <fieldset className="rounded border p-2">
      <legend className="px-1 text-xs font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-3">
        {SCOPES.map((scope) => (
          <label key={scope} className="flex min-h-11 items-center gap-1.5 text-xs md:min-h-0">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={value.includes(scope)}
              onChange={() =>
                onChange(
                  value.includes(scope) ? value.filter((s) => s !== scope) : [...value, scope],
                )
              }
            />
            <code>{scope}</code>
          </label>
        ))}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </fieldset>
  );
}

/**
 * The Drive picker, narrowed to what a routine can actually run: folders stay
 * navigable, files are only shown when they end in .py.
 */
function ChooseScriptDialog({
  open,
  onOpenChange,
  onPicked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPicked: (file: { id: string; name: string }) => void;
}) {
  const [pickError, setPickError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a Python script</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Showing folders and .py files from your own Drive. The routine will re-fetch the
          file before every run.
        </p>
        {pickError && (
          <p role="alert" className="text-sm text-destructive">
            {pickError}
          </p>
        )}
        <div className="min-h-0 flex-1">
          <DriveBrowser
            // Not "My Drive": DriveBrowser keys its query cache by rootName,
            // and this browser's pages are filtered — they must not be served
            // to (or from) the unfiltered My Drive surfaces.
            rootName="Python scripts"
            searchable
            fetchPage={async (opts) => {
              const page = await listDriveFiles(opts);
              return {
                ...page,
                files: page.files.filter((f) => f.isFolder || /\.py$/i.test(f.name)),
              };
            }}
            onPickFile={(file) => {
              if (!/\.py$/i.test(file.name)) {
                setPickError(`"${file.name}" is not a .py file — pick a Python script.`);
                return;
              }
              setPickError(null);
              onPicked({ id: file.id, name: file.name });
              onOpenChange(false);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Semantic tokens only, so both themes hold: brand = in flight, accent = done,
// destructive = broke. Every chip also carries its status as text.
const STATUS_STYLE: Record<RoutineRun['status'], string> = {
  running: 'animate-pulse bg-primary/15 text-primary',
  succeeded: 'bg-accent text-accent-foreground',
  failed: 'bg-destructive/15 text-destructive',
  // Not a failure: the routine worked and ran out of its allowance — outlined, not filled.
  budget_exceeded: 'border text-muted-foreground',
};

function RunHistory({ runs }: { runs: RoutineRun[] }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const open = runs.find((r) => r.id === openId) ?? runs[0];

  if (runs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No runs yet — press Run now to try it.</p>
    );
  }

  return (
    <div className="rounded border p-2">
      <div className="mb-2 flex flex-wrap gap-1">
        {runs.slice(0, 15).map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setOpenId(r.id)}
            className={`flex min-h-11 items-center rounded px-2 py-0.5 text-xs transition-shadow md:min-h-0 ${STATUS_STYLE[r.status]} ${
              open?.id === r.id ? 'font-medium ring-1 ring-foreground/30' : ''
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
            {open.scriptRunId
              ? // A drive_script run: no model turns, no tokens — the sandbox run is the story.
                `sandbox run #${open.scriptRunId}`
              : `${open.iterations} step${open.iterations === 1 ? '' : 's'} · ${
                  open.inputTokens + open.outputTokens
                } tokens`}
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
          {entry.type === 'script_queued' && (
            <p>
              <span className="font-medium">queued</span> sandbox run{' '}
              <code>#{entry.scriptRunId}</code> from <code>{entry.fileName}</code> (
              {Math.max(1, Math.ceil(entry.sourceBytes / 1024))} KB)
            </p>
          )}
          {entry.type === 'script_result' && (
            <div className="grid gap-1">
              <p>
                <span className="font-medium">script {entry.status}</span>
                {entry.exitCode !== null && (
                  <>
                    {' '}
                    · exit code <code>{entry.exitCode}</code>
                  </>
                )}
              </p>
              {entry.stdout && (
                <pre className="overflow-x-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap">
                  {entry.stdout}
                </pre>
              )}
              {entry.stderr && (
                <pre className="overflow-x-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap text-destructive">
                  {entry.stderr}
                </pre>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
