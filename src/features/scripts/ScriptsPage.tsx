import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, FileCode2, FilePlus2, Loader2, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { listDriveFiles, type DriveFile } from '@/features/drive/api';
import { DriveBrowser } from '@/features/drive/DriveBrowser';
import { createScript, getScriptsDocUrl, listScripts, setScriptsDocUrl } from './api';
import { ScriptEditor } from './ScriptEditor';

/**
 * Automations → Scripts, laid out like an IDE: a dark explorer rail on the
 * left (VS Code's explorer, via sidebar tokens in both app themes) and the
 * editor pane — tabs, toolbar, terminal-style output — on the right.
 *
 * Admin-only, matching the API. The thing worth getting right in this UI is
 * that a script's **scopes are visible next to its code**: the scopes are what
 * the run's token will carry, so whoever approves a script can see what it may
 * do without reading the body and inferring.
 */

const STARTER = `"""A script runs server-side in a sandbox.

fs_sdk carries this run's token, which holds only the scopes ticked in the
Scopes panel. A call outside them comes back 403.
"""
import fs_sdk

for project in fs_sdk.list_projects():
    print(project["id"], project["name"])
`;

/**
 * The how-to-write-a-script guide is a Google Doc, maintained in Drive where
 * staff already edit docs — the app keeps only the link, and setting it means
 * picking the file in a Drive browser rather than pasting a URL. This page is
 * admin-only, so the edit affordance needs no extra gating.
 */
function ScriptsDocLink() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['scripts-doc-url'], queryFn: getScriptsDocUrl });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (url: string | null) => setScriptsDocUrl(url),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scripts-doc-url'] });
      setDialogOpen(false);
      setError(null);
    },
    onError: () => setError('Must be a drive.google.com or docs.google.com link'),
  });

  function pick(file: DriveFile) {
    const link = file.webViewLink;
    let host = '';
    try {
      host = link ? new URL(link).host : '';
    } catch {
      // not a URL — fall through to the error below
    }
    if (!link || (host !== 'drive.google.com' && host !== 'docs.google.com')) {
      setError('Pick a Google Docs/Drive file');
      return;
    }
    setError(null);
    save.mutate(link);
  }

  const clearing = save.isPending && save.variables === null;

  return (
    <div className="flex items-center gap-0.5 px-1 pb-1">
      {data?.url ? (
        <>
          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-11 min-w-0 items-center gap-1.5 rounded px-2 py-1 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:min-h-7"
          >
            <BookOpen className="size-4 shrink-0" />
            <span className="truncate">Documentation</span>
          </a>
          <button
            type="button"
            aria-label="Change documentation link"
            title="Change documentation link"
            onClick={() => {
              setError(null);
              setDialogOpen(true);
            }}
            className="flex min-h-11 min-w-11 items-center justify-center rounded p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:min-h-7 md:min-w-7"
          >
            <Pencil className="size-3.5" />
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setDialogOpen(true);
          }}
          className="flex min-h-11 items-center gap-1.5 rounded px-2 py-1 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:min-h-7"
        >
          <BookOpen className="size-4" />
          Add docs link
        </button>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setError(null);
        }}
      >
        <DialogContent className="flex h-[85dvh] flex-col gap-3 sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Scripts documentation</DialogTitle>
            <DialogDescription>
              Pick the Google Doc that explains how to write a script — the app stores only the
              link.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1">
            <DriveBrowser
              rootName="My Drive"
              fetchPage={(opts) => listDriveFiles(opts)}
              searchable
              onPickFile={pick}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            {data?.url && (
              <Button
                variant="destructive"
                disabled={save.isPending}
                onClick={() => save.mutate(null)}
              >
                {clearing ? 'Clearing…' : 'Clear link'}
              </Button>
            )}
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ScriptsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['scripts'], queryFn: listScripts });
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const selected = data?.scripts.find((s) => s.id === selectedId) ?? null;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['scripts'] });

  const create = useMutation({
    mutationFn: () => createScript({ name: 'New script', source: STARTER, scopes: [] }),
    onSuccess: (res) => {
      invalidate();
      setSelectedId(res.script.id);
    },
  });

  return (
    <div className="flex h-full">
      {/* Explorer rail — VS Code's dark explorer via sidebar tokens, in both
          app themes. < md: one pane at a time — it hides once a script opens. */}
      <div
        className={`w-full shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex md:w-60 ${
          selected ? 'hidden' : 'flex'
        }`}
      >
        <div className="flex items-center gap-1 px-2 py-1">
          <h1 className="mr-auto text-[11px] font-semibold tracking-widest text-sidebar-foreground/60">
            SCRIPTS
          </h1>
          <button
            type="button"
            aria-label="New script"
            title="New script"
            disabled={create.isPending}
            onClick={() => create.mutate()}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-50 md:min-h-7 md:min-w-7"
          >
            {create.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FilePlus2 className="size-4" />
            )}
          </button>
        </div>
        <ScriptsDocLink />
        {isLoading && (
          <div className="grid gap-1 px-1" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-11 animate-pulse rounded bg-sidebar-accent/50 md:h-7" />
            ))}
          </div>
        )}
        <ul className="grid gap-px px-1 pb-2">
          {data?.scripts.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelectedId(s.id)}
                className={`flex min-h-11 w-full items-center gap-1.5 rounded px-2 py-0.5 text-left text-sm transition-colors hover:bg-sidebar-accent md:min-h-7 ${
                  selectedId === s.id ? 'bg-sidebar-accent font-medium' : ''
                }`}
              >
                <FileCode2 className="size-4 shrink-0 text-sidebar-foreground/60" />
                <span className="truncate">{s.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {data?.scripts.length === 0 && (
          <p className="px-3 text-xs text-sidebar-foreground/60">
            No scripts yet — press New to write the first one.
          </p>
        )}
      </div>

      <div className={`min-w-0 flex-1 flex-col ${selected ? 'flex' : 'hidden md:flex'}`}>
        {selected ? (
          <ScriptEditor
            key={selected.id}
            script={selected}
            onChanged={invalidate}
            onDeleted={() => {
              setSelectedId(null);
              invalidate();
            }}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            Select a script, or create one. Scripts run server-side in a sandbox with a hard
            timeout and only the scopes you grant them.
          </p>
        )}
      </div>
    </div>
  );
}
