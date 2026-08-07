import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/features/auth/authStore';
import { getSocket } from '@/lib/socket';
import { getSheet, saveSheet, type SheetLock } from './api';
import { mountUniver, type UniverHandle } from './univer';
import { hasMacros, snapshotToXlsx, xlsxToSnapshot } from './xlsx';

/**
 * One spreadsheet, with lock-based single-editor concurrency.
 *
 * The rules this page has to hold up:
 *
 * - Only the lock holder may save. Everyone else watches, and is told who is
 *   editing rather than being left to wonder why their changes vanish.
 * - The lock is held by a *socket*, so closing this tab releases it. That is why
 *   acquire/release go over the socket rather than through REST.
 * - Univer is mounted imperatively into a ref'd div. There is no official React
 *   wrapper, and mounting it twice into one container leaves two engines fighting
 *   over the same canvas — hence the disposal on unmount.
 */

const AUTOSAVE_MS = 5000;

export function SheetPage() {
  const { sheetId: rawId } = useParams();
  const sheetId = Number(rawId);

  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<UniverHandle | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState('');
  const [lock, setLock] = useState<SheetLock | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Whether *this* client holds the lock. Derived from the server's view of who
  // holds it, not from "did I click the button" — a reconnect can lose the lock
  // without asking, and the button would then lie about being able to save.
  const socket = getSocket();
  const myUserId = useAuthStore((s) => s.user?.id);
  const iAmEditing = lock !== null && lock.userId === myUserId;

  // Mount Univer once, with whatever snapshot the server has.
  useEffect(() => {
    if (!Number.isInteger(sheetId) || sheetId <= 0) {
      setStatus('error');
      setMessage('That sheet id is not valid.');
      return;
    }
    let disposed = false;

    (async () => {
      try {
        const { sheet, lock: currentLock } = await getSheet(sheetId);
        if (disposed || !containerRef.current) return;
        setTitle(sheet.title);
        setLock(currentLock);
        univerRef.current = await mountUniver(containerRef.current, sheet.data, () => {
          dirtyRef.current = true;
        });
        setStatus('ready');
      } catch (err) {
        if (!disposed) {
          setStatus('error');
          setMessage(err instanceof Error ? err.message : 'Could not open that sheet');
        }
      }
    })();

    return () => {
      disposed = true;
      univerRef.current?.dispose();
      univerRef.current = null;
    };
  }, [sheetId]);

  // Watch for other people's saves and lock changes.
  useEffect(() => {
    if (!Number.isInteger(sheetId)) return;
    socket.emit('sheet:watch', sheetId);

    const onLock = (payload: { sheetId: number; lock: SheetLock | null }) => {
      if (payload.sheetId === sheetId) setLock(payload.lock);
    };
    const onUpdated = (payload: { sheetId: number }) => {
      // Only viewers refetch. Reloading under the editor would throw away
      // whatever they have typed since their last autosave.
      if (payload.sheetId !== sheetId || dirtyRef.current) return;
      void refresh();
    };

    socket.on('sheet:lock', onLock);
    socket.on('sheet:updated', onUpdated);
    return () => {
      socket.off('sheet:lock', onLock);
      socket.off('sheet:updated', onUpdated);
      socket.emit('sheet:unwatch', sheetId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetId]);

  async function refresh() {
    const { sheet, lock: currentLock } = await getSheet(sheetId);
    setTitle(sheet.title);
    setLock(currentLock);
    univerRef.current?.load(sheet.data);
  }

  async function save(reason: 'auto' | 'manual') {
    if (!univerRef.current || savingRef.current) return;
    if (!dirtyRef.current && reason === 'auto') return;
    savingRef.current = true;
    try {
      const data = univerRef.current.snapshot();
      const res = await saveSheet(sheetId, { data });
      dirtyRef.current = false;
      setLock(res.lock);
      setSavedAt(new Date().toLocaleTimeString());
      setMessage(null);
    } catch (err) {
      // A 409 is not a transient failure to retry — it means someone else took
      // the sheet, and the only honest thing is to say so.
      setMessage(err instanceof Error ? err.message : 'Could not save');
    } finally {
      savingRef.current = false;
    }
  }

  // Autosave, but only while holding the lock.
  useEffect(() => {
    if (!iAmEditing || status !== 'ready') return;
    const timer = setInterval(() => void save('auto'), AUTOSAVE_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iAmEditing, status]);

  // And on the way out, so the last few seconds of work are not lost.
  useEffect(() => {
    return () => {
      if (dirtyRef.current) void save('manual');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Replace the workbook from an uploaded .xlsx/.xlsm, then save it. */
  async function importXlsx(file: File) {
    if (!univerRef.current) return;
    setMessage(null);
    try {
      const snapshot = xlsxToSnapshot(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''));
      univerRef.current.load(JSON.stringify(snapshot));
      dirtyRef.current = true;
      await save('manual');
      // Stated rather than silent: the data and formulas arrived, the macros did
      // not, and every web spreadsheet behaves this way — Google's included.
      if (hasMacros(file.name)) {
        setMessage('Imported. Macros (VBA) were not imported — no web spreadsheet can run them.');
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not read that spreadsheet');
    }
  }

  function exportXlsx() {
    if (!univerRef.current) return;
    try {
      const blob = snapshotToXlsx(JSON.parse(univerRef.current.snapshot() || '{}'));
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${title || 'sheet'}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not export that sheet');
    }
  }

  function takeLock() {
    socket.emit('sheet:lock:acquire', sheetId, (res: { ok: boolean; lock?: SheetLock }) => {
      if (res.ok && res.lock) setLock(res.lock);
      else setMessage(`${res.lock?.displayName ?? 'Someone else'} is editing this sheet.`);
    });
  }

  function releaseLock() {
    void save('manual').then(() => {
      socket.emit('sheet:lock:release', sheetId, () => setLock(null));
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        {/* Full-width on phones so the lock badge and buttons get their own row. */}
        <h1 className="w-full min-w-0 truncate text-sm font-semibold md:mr-auto md:w-auto">
          {title || 'Sheet'}
        </h1>

        {lock && !iAmEditing && (
          <span className="rounded-md border bg-accent px-2 py-1 text-xs font-medium whitespace-nowrap text-accent-foreground">
            View only — {lock.displayName} is editing
          </span>
        )}
        {savedAt && iAmEditing && (
          <span className="text-xs whitespace-nowrap text-muted-foreground">Saved {savedAt}</span>
        )}
        <Button size="sm" variant="outline" className="min-h-11 md:min-h-7" onClick={exportXlsx}>
          Export .xlsx
        </Button>
        {iAmEditing && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 md:min-h-7"
            onClick={() => importRef.current?.click()}
            title="Replaces the whole workbook"
          >
            Import .xlsx
          </Button>
        )}
        <input
          ref={importRef}
          type="file"
          accept=".xlsx,.xlsm,.csv"
          className="hidden"
          aria-label="Import spreadsheet"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importXlsx(file);
          }}
        />

        {iAmEditing ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 md:min-h-7"
              onClick={() => void save('manual')}
            >
              Save now
            </Button>
            <Button size="sm" className="min-h-11 md:min-h-7" onClick={releaseLock}>
              Done editing
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            className="min-h-11 md:min-h-7"
            disabled={lock !== null}
            onClick={takeLock}
          >
            {lock ? 'Locked' : 'Edit'}
          </Button>
        )}
      </div>

      {message && (
        <p role="alert" className="border-b bg-destructive/10 px-3 py-1 text-xs text-destructive">
          {message}
        </p>
      )}
      {status === 'loading' && (
        <div className="m-3 flex-1 animate-pulse rounded-md bg-muted" aria-label="Opening sheet" />
      )}

      {/* Univer renders into this element imperatively; React must not touch its children. */}
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
