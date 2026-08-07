import { redo, undo } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { useMutation, useQuery } from '@tanstack/react-query';
import CodeMirror, { type EditorView } from '@uiw/react-codemirror';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  Loader2,
  Play,
  Redo2,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  assistScript,
  deleteScript,
  listRuns,
  runScript,
  SCOPES,
  updateScript,
  type AssistMode,
  type Scope,
  type Script,
  type ScriptRun,
} from './api';

/**
 * The VS Code-shaped editor pane: tab strip, icon toolbar, collapsible scopes
 * row, CodeMirror, and a terminal-style OUTPUT panel at the bottom.
 *
 * The whole pane carries the `dark` class so every semantic token inside
 * resolves to its dark value in both app themes — the editor chrome is dark
 * the way VS Code's is, without a single hardcoded color.
 */

/** Icon toolbar button. `onMouseDown` preventDefault so it never steals the
 * editor's focus — the next keystroke must stay in CodeMirror. */
function IconBtn({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`flex min-h-11 min-w-11 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-50 md:min-h-7 md:min-w-7 ${
        danger
          ? 'text-destructive hover:bg-destructive/15'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground'
      }`}
    >
      {children}
    </button>
  );
}

export function ScriptEditor({
  script,
  onChanged,
  onDeleted,
  onBack,
}: {
  script: Script;
  onChanged: () => void;
  onDeleted: () => void;
  onBack: () => void;
}) {
  const [name, setName] = useState(script.name);
  const [source, setSource] = useState(script.source);
  const [scopes, setScopes] = useState<Scope[]>(script.scopes);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [scopesOpen, setScopesOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMode, setAiMode] = useState<AssistMode>('analyze');
  const [aiInstruction, setAiInstruction] = useState('');
  const viewRef = useRef<EditorView | null>(null);

  const dirty =
    name !== script.name ||
    source !== script.source ||
    [...scopes].sort().join(',') !== [...script.scopes].sort().join(',');

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
      setError(null);
      setWatching(true);
      void runsQuery.refetch();
      onChanged();
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Could not run'),
  });

  const remove = useMutation({ mutationFn: () => deleteScript(script.id), onSuccess: onDeleted });

  // The AI reads the editor's current source, saved or not — asking about the
  // code on screen is the whole point. The reply never touches the script until
  // Apply, and Apply only sets the same source state typing does, so the dirty
  // dot and manual Save stay in charge.
  const assist = useMutation({
    mutationFn: () => assistScript({ source, instruction: aiInstruction.trim(), mode: aiMode }),
  });
  const aiError = assist.isError
    ? assist.error instanceof Error
      ? assist.error.message
      : 'Could not ask the AI'
    : null;

  function toggleScope(scope: Scope) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  function historyCommand(command: typeof undo) {
    const view = viewRef.current;
    if (view) command({ state: view.state, dispatch: view.dispatch });
  }

  return (
    <div className="dark flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground animate-in fade-in duration-150">
      {/* Tab strip — one open file, VS Code style, with the dirty dot. */}
      <div className="flex min-h-11 items-stretch border-b border-sidebar-border md:min-h-9">
        <button
          type="button"
          aria-label="Back to scripts"
          onClick={onBack}
          className="flex min-w-11 items-center justify-center text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:hidden"
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="flex min-w-0 items-center gap-1.5 border-r border-sidebar-border bg-sidebar-accent/60 px-2.5">
          <FileCode2 className="size-3.5 shrink-0 text-sidebar-primary" />
          <input
            value={name}
            aria-label="Script name"
            onChange={(e) => setName(e.target.value)}
            className="w-32 min-w-0 rounded-sm bg-transparent text-base outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring sm:w-48 md:text-[13px]"
          />
          <span
            aria-hidden={!dirty}
            title={dirty ? 'Unsaved changes' : undefined}
            className={`shrink-0 text-[10px] leading-none ${dirty ? '' : 'opacity-0'}`}
          >
            ●
          </span>
          {dirty && <span className="sr-only">Unsaved changes</span>}
        </div>
      </div>

      {/* Toolbar — icon actions over the editor. */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-sidebar-border p-1">
        <IconBtn label={save.isPending ? 'Saving…' : 'Save'} disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
        </IconBtn>
        <IconBtn
          label={run.isPending ? 'Queueing…' : 'Save and run'}
          disabled={run.isPending}
          onClick={() => {
            setOutputOpen(true);
            run.mutate();
          }}
        >
          {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
        </IconBtn>
        <div className="mx-0.5 h-4 w-px self-center bg-sidebar-border" aria-hidden />
        <IconBtn label="Undo" onClick={() => historyCommand(undo)}>
          <Undo2 className="size-4" />
        </IconBtn>
        <IconBtn label="Redo" onClick={() => historyCommand(redo)}>
          <Redo2 className="size-4" />
        </IconBtn>
        <div className="mx-0.5 h-4 w-px self-center bg-sidebar-border" aria-hidden />
        <button
          type="button"
          aria-label="AI assistant"
          title="AI assistant"
          aria-expanded={aiOpen}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAiOpen((v) => !v)}
          className={`flex min-h-11 min-w-11 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring md:min-h-7 md:min-w-7 ${
            aiOpen
              ? 'bg-sidebar-accent text-sidebar-foreground'
              : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground'
          }`}
        >
          <Sparkles className="size-4" />
        </button>
        <div className="mx-0.5 h-4 w-px self-center bg-sidebar-border" aria-hidden />
        <button
          type="button"
          aria-expanded={scopesOpen}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setScopesOpen((v) => !v)}
          className="flex min-h-11 items-center gap-1 rounded-md px-1.5 text-xs text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring md:min-h-7"
        >
          <ShieldCheck className="size-3.5" />
          Scopes ({scopes.length})
          {scopesOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <span className="hidden px-1 text-[11px] text-sidebar-foreground/50 md:inline">Python</span>
          <IconBtn
            label={remove.isPending ? 'Deleting…' : 'Delete script'}
            danger
            disabled={remove.isPending}
            onClick={() => {
              if (confirm(`Delete script "${name.trim() || script.name}"?`)) remove.mutate();
            }}
          >
            {remove.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          </IconBtn>
        </div>
      </div>

      {/* Scopes — what the run's token will carry. Whoever approves a script
          sees what it may do without reading the body and inferring. */}
      {scopesOpen && (
        <fieldset className="border-b border-sidebar-border px-2 py-1.5 animate-in fade-in duration-150">
          <legend className="sr-only">
            Scopes — what this script may do through fs_sdk
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            {SCOPES.map((scope) => (
              <label key={scope} className="flex min-h-11 items-center gap-1.5 text-xs md:min-h-6">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                <code>{scope}</code>
              </label>
            ))}
          </div>
          {scopes.length === 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              No scopes: the script can compute and print, but every API call will be refused.
            </p>
          )}
        </fieldset>
      )}

      {error && (
        <p role="alert" className="border-b border-sidebar-border px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Editor fills everything the panels don't take; the AI assistant docks
          to its right on desktop and slides in under it on mobile. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <CodeMirror
            value={source}
            height="100%"
            className="h-full text-[13px]"
            theme={oneDark}
            extensions={[python()]}
            onChange={setSource}
            onCreateEditor={(view) => {
              viewRef.current = view;
            }}
            basicSetup={{ lineNumbers: true, highlightActiveLine: true }}
          />
        </div>

        {aiOpen && (
          <div className="flex max-h-[45dvh] shrink-0 flex-col border-t border-sidebar-border animate-in fade-in slide-in-from-bottom-2 duration-150 md:max-h-none md:w-80 md:border-t-0 md:border-l md:slide-in-from-right-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (aiInstruction.trim() && !assist.isPending) assist.mutate();
              }}
              className="flex flex-col gap-1.5 border-b border-sidebar-border p-2"
            >
              <div className="flex items-center gap-1.5">
                <Sparkles className="size-3.5 shrink-0 text-sidebar-primary" />
                <span className="text-[11px] font-semibold tracking-widest text-sidebar-foreground/60">
                  AI
                </span>
                <select
                  aria-label="What the AI should do"
                  value={aiMode}
                  onChange={(e) => setAiMode(e.target.value as AssistMode)}
                  className="ml-auto rounded-md border border-sidebar-border bg-sidebar px-1.5 py-1 text-xs text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                >
                  <option value="analyze">Analyze</option>
                  <option value="generate">Generate</option>
                  <option value="edit">Edit</option>
                </select>
              </div>
              <textarea
                aria-label="Instruction for the AI"
                // The panel only appears on an explicit click, so taking focus is the expected next step.
                autoFocus
                rows={3}
                value={aiInstruction}
                onChange={(e) => setAiInstruction(e.target.value)}
                placeholder={
                  aiMode === 'analyze'
                    ? 'e.g. What does this script do? Any bugs?'
                    : aiMode === 'generate'
                      ? 'e.g. Write a script that posts a summary to a channel'
                      : 'e.g. Add error handling around the fs_sdk calls'
                }
                className="resize-none rounded-md border border-sidebar-border bg-background/50 px-2 py-1.5 text-base outline-none transition-colors placeholder:text-sidebar-foreground/40 focus-visible:ring-2 focus-visible:ring-sidebar-ring md:text-xs"
              />
              <button
                type="submit"
                disabled={assist.isPending || !aiInstruction.trim()}
                className="flex min-h-11 items-center justify-center rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-50 md:min-h-7"
              >
                {assist.isPending ? 'Asking…' : 'Ask'}
              </button>
              {aiError && (
                <p role="alert" className="text-xs text-destructive">
                  {aiError}
                </p>
              )}
            </form>

            <div className="min-h-0 flex-1 overflow-auto px-2.5 py-1.5">
              {assist.isPending ? (
                <div className="grid gap-1" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-3 animate-pulse rounded bg-sidebar-accent/60" />
                  ))}
                </div>
              ) : assist.data ? (
                <>
                  {assist.data.revisedSource !== null && (
                    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <button
                        type="button"
                        onClick={() => setSource(assist.data!.revisedSource!)}
                        className="flex min-h-11 items-center rounded-md bg-sidebar-accent px-2 text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring md:min-h-7"
                      >
                        Apply to editor
                      </button>
                      <span className="text-[11px] text-sidebar-foreground/60">
                        Replaces the editor contents — Save is still manual.
                      </span>
                    </div>
                  )}
                  <pre className="whitespace-pre-wrap font-mono text-xs text-sidebar-foreground/90">
                    {assist.data.reply}
                  </pre>
                </>
              ) : (
                !aiError && (
                  <p className="text-xs text-sidebar-foreground/60">
                    Ask about this script, generate a new one, or have it edited — the reply
                    lands here.
                  </p>
                )
              )}
            </div>
          </div>
        )}
      </div>

      <OutputPanel
        runs={runs}
        loading={runsQuery.isLoading}
        open={outputOpen}
        onToggle={() => setOutputOpen((v) => !v)}
      />
    </div>
  );
}

// Semantic tokens only, resolved in the pane's forced-dark scheme: brand = in
// flight, accent = done, destructive = broke. Every chip also carries its
// status as text.
const STATUS_STYLE: Record<ScriptRun['status'], string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'animate-pulse bg-primary/15 text-primary',
  succeeded: 'bg-accent text-accent-foreground',
  failed: 'bg-destructive/15 text-destructive',
  // A runaway reads differently from a bug: outlined, not filled.
  timeout: 'border border-destructive/40 text-destructive',
};

const STATUS_TEXT: Record<ScriptRun['status'], string> = {
  queued: 'text-muted-foreground',
  running: 'animate-pulse text-primary',
  succeeded: 'text-primary',
  failed: 'text-destructive',
  timeout: 'text-destructive',
};

/** Terminal-style bottom panel: chevron header, run chips, monospace output. */
function OutputPanel({
  runs,
  loading,
  open,
  onToggle,
}: {
  runs: ScriptRun[];
  loading: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  const shown = runs.find((r) => r.id === openId) ?? runs[0];
  const latest = runs[0];

  return (
    <div className="shrink-0 border-t border-sidebar-border">
      <button
        type="button"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggle}
        className="flex min-h-11 w-full items-center gap-1 px-2 text-left transition-colors hover:bg-sidebar-accent/50 focus-visible:ring-2 focus-visible:ring-sidebar-ring md:min-h-7"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="text-[11px] font-semibold tracking-widest text-sidebar-foreground/60">
          OUTPUT
        </span>
        {!open && latest && (
          <span className={`ml-2 truncate text-[11px] ${STATUS_TEXT[latest.status]}`}>
            run #{latest.id} · {latest.status}
          </span>
        )}
      </button>

      {open && (
        <div className="flex h-[40dvh] flex-col md:h-64 animate-in fade-in duration-150">
          {loading ? (
            <div className="m-2 flex-1 animate-pulse rounded bg-muted" aria-hidden />
          ) : runs.length === 0 ? (
            <p className="px-3 py-2 font-mono text-xs text-muted-foreground">
              No runs yet — press Run to queue one.
            </p>
          ) : (
            <>
              <div className="flex gap-1 overflow-x-auto border-b border-sidebar-border px-2 py-1">
                {runs.slice(0, 12).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setOpenId(r.id)}
                    className={`flex min-h-11 shrink-0 items-center rounded px-2 text-[11px] transition-shadow md:min-h-5 ${STATUS_STYLE[r.status]} ${
                      shown?.id === r.id ? 'font-medium ring-1 ring-sidebar-ring' : ''
                    }`}
                    title={new Date(r.createdAt).toLocaleString()}
                  >
                    #{r.id} {r.status}
                  </button>
                ))}
              </div>
              {shown && (
                <div className="min-h-0 flex-1 overflow-auto bg-background/50 px-2.5 py-1.5 font-mono text-xs">
                  <p className={STATUS_TEXT[shown.status]}>
                    run #{shown.id} · {shown.status}
                    {shown.exitCode !== null && ` · exit ${shown.exitCode}`}
                    {shown.finishedAt && ` · ${new Date(shown.finishedAt).toLocaleTimeString()}`}
                  </p>
                  {shown.error && <p className="text-destructive">{shown.error}</p>}
                  {shown.stdout && (
                    <pre className="whitespace-pre-wrap text-sidebar-foreground/90">
                      {shown.stdout}
                    </pre>
                  )}
                  {shown.stderr && (
                    <pre className="whitespace-pre-wrap text-destructive">{shown.stderr}</pre>
                  )}
                  {!shown.stdout &&
                    !shown.stderr &&
                    shown.status !== 'queued' &&
                    shown.status !== 'running' && (
                      <p className="text-muted-foreground">No output.</p>
                    )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
