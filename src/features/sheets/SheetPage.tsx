import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/features/auth/authStore';
import { getSocket } from '@/lib/socket';
import { getSheet, saveSheet, type SheetLock } from './api';
import { mountUniver, type UniverHandle } from './univer';

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
        <h1 className="mr-auto text-sm font-semibold">{title || 'Sheet'}</h1>

        {lock && !iAmEditing && (
          <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">
            View only — {lock.displayName} is editing
          </span>
        )}
        {savedAt && iAmEditing && (
          <span className="text-xs text-muted-foreground">Saved {savedAt}</span>
        )}

        {iAmEditing ? (
          <>
            <Button size="sm" variant="outline" onClick={() => void save('manual')}>
              Save now
            </Button>
            <Button size="sm" onClick={releaseLock}>
              Done editing
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={lock !== null} onClick={takeLock}>
            {lock ? 'Locked' : 'Edit'}
          </Button>
        )}
      </div>

      {message && (
        <p role="alert" className="border-b bg-destructive/10 px-3 py-1 text-xs text-destructive">
          {message}
        </p>
      )}
      {status === 'loading' && <p className="p-3 text-sm text-muted-foreground">Opening sheet…</p>}

      {/* Univer renders into this element imperatively; React must not touch its children. */}
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
