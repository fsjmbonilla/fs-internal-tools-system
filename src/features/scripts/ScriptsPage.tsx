import { python } from '@codemirror/lang-python';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CodeMirror from '@uiw/react-codemirror';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  createScript,
  deleteScript,
  listRuns,
  listScripts,
  runScript,
  SCOPES,
  updateScript,
  type Scope,
  type Script,
  type ScriptRun,
} from './api';

/**
 * Automations → Scripts.
 *
 * Admin-only, matching the API. The thing worth getting right in this UI is that
 * a script's **scopes are visible next to its code**: the scopes are what the
 * run's token will carry, so whoever approves a script can see what it may do
 * without reading the body and inferring.
 */

const STARTER = `"""A script runs server-side in a sandbox.

fs_sdk carries this run's token, which holds only the scopes ticked below.
A call outside them comes back 403.
"""
import fs_sdk

for project in fs_sdk.list_projects():
    print(project["id"], project["name"])
`;

export function ScriptsPage() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['scripts'], queryFn: listScripts });
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const selected = data?.scripts.find((s) => s.id === selectedId) ?? null;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['scripts'] });

  const create = useMutation({
    mutationFn: () =>
      createScript({ name: 'New script', source: STARTER, scopes: [] }),
    onSuccess: (res) => {
      invalidate();
      setSelectedId(res.script.id);
    },
  });

  return (
    <div className="flex h-full">
      <div className="w-64 shrink-0 border-r p-2">
        <div className="mb-2 flex items-center gap-2">
          <h1 className="mr-auto text-sm font-semibold">Scripts</h1>
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
            New
          </Button>
        </div>
        <ul className="grid gap-1">
          {data?.scripts.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelectedId(s.id)}
                className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${
                  selectedId === s.id ? 'bg-muted' : ''
                }`}
              >
                {s.name}
              </button>
            </li>
          ))}
        </ul>
        {data?.scripts.length === 0 && (
          <p className="text-xs text-muted-foreground">No scripts yet.</p>
        )}
      </div>

      <div className="min-w-0 flex-1 p-3">
        {selected ? (
          <ScriptEditor
            key={selected.id}
            script={selected}
            onChanged={invalidate}
            onDeleted={() => {
              setSelectedId(null);
              invalidate();
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Select a script, or create one. Scripts run server-side in a sandbox with a hard
            timeout and only the scopes you grant them.
          </p>
        )}
      </div>
    </div>
  );
}

function ScriptEditor({
  script,
  onChanged,
  onDeleted,
}: {
  script: Script;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(script.name);
  const [source, setSource] = useState(script.source);
  const [scopes, setScopes] = useState<Scope[]>(script.scopes);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);

  const runsQuery = useQuery({
    queryKey: ['script-runs', script.id],
    queryFn: () => listRuns(script.id),
    // Only poll while something is in flight. A run takes seconds, and polling
    // for it forever would be a request every two seconds for nothing.
    refetchInterval: watching ? 2000 : false,
  });

  const runs = runsQuery.data?.runs ?? [];
  const latest = runs[0];

  useEffect(() => {
    if (latest && (latest.status === 'queued' || latest.status === 'running')) setWatching(true);
    else setWatching(false);
  }, [latest]);

  const save = useMutation({
    mutationFn: () => updateScript(script.id, { name: name.trim() || 'Untitled', source, scopes }),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Could not save'),
  });

  const run = useMutation({
    // Save first: running the previous version of code you are looking at is a
    // confusing way to lose ten minutes.
    mutationFn: async () => {
      await updateScript(script.id, { name: name.trim() || 'Untitled', source, scopes });
      return runScript(script.id);
    },
    onSuccess: () => {
      setWatching(true);
      void runsQuery.refetch();
      onChanged();
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Could not run'),
  });

  const remove = useMutation({ mutationFn: () => deleteScript(script.id), onSuccess: onDeleted });

  function toggleScope(scope: Scope) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          className="max-w-72"
          value={name}
          aria-label="Script name"
          onChange={(e) => setName(e.target.value)}
        />
        <span className="mr-auto text-xs text-muted-foreground">Python</span>
        <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? 'Queueing…' : 'Run'}
        </Button>
        <Button size="sm" variant="destructive" onClick={() => remove.mutate()}>
          Delete
        </Button>
      </div>

      <fieldset className="rounded border p-2">
        <legend className="px-1 text-xs font-medium">
          Scopes — what this script may do through <code>fs_sdk</code>
        </legend>
        <div className="flex flex-wrap gap-3">
          {SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={() => toggleScope(scope)}
              />
              <code>{scope}</code>
            </label>
          ))}
        </div>
        {scopes.length === 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            No scopes: the script can compute and print, but every API call will be refused.
          </p>
        )}
      </fieldset>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded border">
        <CodeMirror
          value={source}
          height="100%"
          extensions={[python()]}
          onChange={setSource}
          basicSetup={{ lineNumbers: true, highlightActiveLine: true }}
        />
      </div>

      <RunPanel runs={runs} />
    </div>
  );
}

const STATUS_STYLE: Record<ScriptRun['status'], string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-blue-100 text-blue-900',
  succeeded: 'bg-green-100 text-green-900',
  failed: 'bg-red-100 text-red-900',
  // A runaway reads differently from a bug, so it gets its own colour.
  timeout: 'bg-amber-100 text-amber-900',
};

function RunPanel({ runs }: { runs: ScriptRun[] }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const open = runs.find((r) => r.id === openId) ?? runs[0];

  if (runs.length === 0) {
    return <p className="text-xs text-muted-foreground">No runs yet.</p>;
  }

  return (
    <div className="max-h-64 shrink-0 overflow-auto rounded border p-2">
      <div className="mb-2 flex flex-wrap gap-1">
        {runs.slice(0, 12).map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setOpenId(r.id)}
            className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[r.status]} ${
              open?.id === r.id ? 'ring-1 ring-foreground/30' : ''
            }`}
            title={new Date(r.createdAt).toLocaleString()}
          >
            #{r.id} {r.status}
          </button>
        ))}
      </div>

      {open && (
        <div className="grid gap-1 text-xs">
          <p className="text-muted-foreground">
            run #{open.id} · {open.status}
            {open.exitCode !== null && ` · exit ${open.exitCode}`}
            {open.finishedAt && ` · ${new Date(open.finishedAt).toLocaleTimeString()}`}
          </p>
          {open.error && <p className="text-destructive">{open.error}</p>}
          {open.stdout && (
            <pre className="overflow-x-auto rounded bg-muted p-2 whitespace-pre-wrap">
              {open.stdout}
            </pre>
          )}
          {open.stderr && (
            <pre className="overflow-x-auto rounded bg-destructive/10 p-2 whitespace-pre-wrap text-destructive">
              {open.stderr}
            </pre>
          )}
          {!open.stdout && !open.stderr && open.status !== 'queued' && open.status !== 'running' && (
            <p className="text-muted-foreground">No output.</p>
          )}
        </div>
      )}
    </div>
  );
}
