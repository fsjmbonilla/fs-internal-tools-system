import { TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/features/docs/Markdown';
import type { UniverHandle } from '@/features/sheets/univer';
import { fetchAuthedBytes } from '@/lib/uploads';
import { updateDriveFileContent, type DriveFile } from './api';
import type { DriveEditorKind } from './preview';

/**
 * Full-screen editing of a Drive file with the app's own editors.
 *
 * - 'sheet' (Google Sheet or plain xlsx): the exported xlsx loads into the same
 *   Univer engine the native Sheets feature uses, via the existing SheetJS
 *   translation in `sheets/xlsx.ts`. Saving writes xlsx bytes back; Drive
 *   converts them into the Sheet in place.
 * - 'doc' (Google Doc): the exported docx becomes markdown through mammoth (the
 *   OfficePreview pattern) and is edited DocPage-style — textarea plus a live
 *   preview. Saving writes text/markdown back; Drive converts it into the Doc.
 *
 * Univer, SheetJS and mammoth are all dynamic imports so the drive chunk does
 * not carry a spreadsheet engine for the sessions that never press Edit.
 *
 * This is a plain fixed overlay, not a Radix Dialog, on purpose: Univer owns
 * everything inside its container and may float popups; a modal Dialog's focus
 * trap and body pointer-events lockdown are exactly the interference it does
 * not need.
 */

/** One confirmation per session — the first save is the surprising one. */
const CONFIRM_KEY = 'drive-edit-replace-confirmed';

export function DriveFileEditor({
  file,
  kind,
  onClose,
  onSaved,
}: {
  file: DriveFile;
  kind: DriveEditorKind;
  onClose: () => void;
  /** Fired after each successful save with the refreshed Drive metadata. */
  onSaved: (updated: DriveFile) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<UniverHandle | null>(null);
  const dirtyRef = useRef(false);

  const [markdown, setMarkdown] = useState('');
  const [mobilePane, setMobilePane] = useState<'write' | 'preview'>('write');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  // Load the export and stand the editor up. The `disposed` guard plus the
  // cleanup is the StrictMode-safe shape (see SheetPage) — a ref that survives
  // the first unmount would leave the second mount skipped and the page blank.
  useEffect(() => {
    let disposed = false;
    setStatus('loading');
    setLoadError(null);

    (async () => {
      try {
        const bytes = await fetchAuthedBytes(
          `/api/drive/files/${encodeURIComponent(file.id)}/export`,
        );
        if (disposed) return;

        if (kind === 'sheet') {
          const [{ mountUniver }, { xlsxToSnapshot }] = await Promise.all([
            import('@/features/sheets/univer'),
            import('@/features/sheets/xlsx'),
          ]);
          if (disposed || !containerRef.current) return;
          const handle = await mountUniver(
            containerRef.current,
            JSON.stringify(xlsxToSnapshot(bytes, file.name)),
            () => {
              dirtyRef.current = true;
            },
          );
          // The cleanup may have run while mountUniver was mid-await — dispose
          // the freshly created engine rather than leaking it into the ref.
          if (disposed) {
            handle.dispose();
            return;
          }
          univerRef.current = handle;
        } else {
          const mammoth = await import('mammoth');
          // convertToMarkdown exists at runtime but is missing from mammoth's
          // type declarations — the same narrow cast OfficePreview documents.
          const convert = (
            mammoth as unknown as {
              convertToMarkdown: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
            }
          ).convertToMarkdown;
          const result = await convert({ arrayBuffer: bytes });
          if (disposed) return;
          setMarkdown(result.value);
        }
        if (!disposed) setStatus('ready');
      } catch (err) {
        if (!disposed) {
          setStatus('error');
          setLoadError(err instanceof Error ? err.message : 'Could not open that file');
        }
      }
    })();

    return () => {
      disposed = true;
      univerRef.current?.dispose();
      univerRef.current = null;
    };
  }, [file.id, file.name, kind, retryToken]);

  async function save() {
    if (saving || status !== 'ready') return;
    if (!sessionStorage.getItem(CONFIRM_KEY)) {
      const ok = window.confirm(
        `Replace the content of “${file.name}” in Drive? Complex formatting/formulas may be simplified.`,
      );
      if (!ok) return;
      sessionStorage.setItem(CONFIRM_KEY, '1');
    }
    setSaving(true);
    setSaveError(null);
    try {
      let blob: Blob;
      if (kind === 'sheet') {
        const handle = univerRef.current;
        if (!handle) throw new Error('The editor is not ready yet');
        const { snapshotToXlsx } = await import('@/features/sheets/xlsx');
        // snapshotToXlsx already stamps the Blob with the xlsx mime type.
        blob = snapshotToXlsx(JSON.parse(handle.snapshot() || '{}'));
      } else {
        blob = new Blob([markdown], { type: 'text/markdown' });
      }
      const { file: updated } = await updateDriveFileContent(file.id, blob, file.name);
      dirtyRef.current = false;
      setSavedAt(new Date().toLocaleTimeString());
      onSaved(updated);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save to Drive');
    } finally {
      setSaving(false);
    }
  }

  function close() {
    if (dirtyRef.current && !window.confirm(`Discard unsaved changes to “${file.name}”?`)) {
      return;
    }
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${file.name}`}
      className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] animate-in fade-in duration-150"
    >
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        {/* Full-width on phones so the action buttons get their own row. */}
        <h2 className="w-full min-w-0 truncate text-sm font-semibold md:mr-auto md:w-auto">
          {file.name}
        </h2>
        {savedAt && (
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            Saved to Drive {savedAt}
          </span>
        )}
        {kind === 'doc' && (
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:hidden"
            onClick={() => setMobilePane((p) => (p === 'write' ? 'preview' : 'write'))}
          >
            {mobilePane === 'write' ? 'Preview' : 'Write'}
          </Button>
        )}
        <Button
          size="sm"
          className="min-h-11 md:min-h-7"
          disabled={saving || status !== 'ready'}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save to Drive'}
        </Button>
        <button
          type="button"
          aria-label="Close editor"
          onClick={close}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:min-h-8 md:min-w-8"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Persistent and honest: a save is a replace, and round-trips simplify. */}
      <p className="flex items-center gap-1.5 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
        <TriangleAlert className="size-3.5 shrink-0" />
        Saving replaces the file’s content in Drive. Complex formatting/formulas may be simplified.
      </p>

      {saveError && (
        <p role="alert" className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {saveError}
        </p>
      )}

      {status === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
          <p role="alert" className="text-sm text-destructive">
            {loadError ?? 'Could not open that file'}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-7"
            onClick={() => setRetryToken((t) => t + 1)}
          >
            Retry
          </Button>
        </div>
      ) : kind === 'sheet' ? (
        <>
          {status === 'loading' && (
            <div className="m-3 flex-1 animate-pulse rounded-md bg-muted" aria-label="Opening spreadsheet" />
          )}
          {/* Univer renders in here imperatively; React must not touch its children. */}
          <div ref={containerRef} className="min-h-0 flex-1" />
        </>
      ) : status === 'loading' ? (
        <div className="m-3 flex-1 animate-pulse rounded-md bg-muted" aria-label="Opening document" />
      ) : (
        <div className="flex min-h-0 flex-1">
          <textarea
            className={`min-h-0 flex-1 resize-none bg-background p-3 font-mono text-base outline-none md:text-sm ${
              mobilePane === 'preview' ? 'hidden md:block' : ''
            }`}
            value={markdown}
            onChange={(e) => {
              setMarkdown(e.target.value);
              dirtyRef.current = true;
            }}
            aria-label={`Markdown content of ${file.name}`}
          />
          {/* Live preview: side-by-side from md up, the toggled pane on phones. */}
          <div
            className={`min-h-0 flex-1 overflow-y-auto p-3 md:border-l ${
              mobilePane === 'write' ? 'hidden md:block' : ''
            }`}
          >
            <Markdown content={markdown} />
          </div>
        </div>
      )}
    </div>
  );
}
