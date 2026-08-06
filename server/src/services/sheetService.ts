import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sheets } from '../db/schema/index.js';

export type SheetRow = typeof sheets.$inferSelect;

/** The list view never ships snapshots — they are megabytes each. */
export type SheetSummary = Omit<SheetRow, 'data'>;

const SUMMARY_COLUMNS = {
  id: sheets.id,
  projectId: sheets.projectId,
  title: sheets.title,
  createdBy: sheets.createdBy,
  updatedBy: sheets.updatedBy,
  createdAt: sheets.createdAt,
  updatedAt: sheets.updatedAt,
};

export async function listSheets(projectId: number): Promise<SheetSummary[]> {
  return db
    .select(SUMMARY_COLUMNS)
    .from(sheets)
    .where(eq(sheets.projectId, projectId))
    .orderBy(desc(sheets.updatedAt));
}

export async function getSheet(id: number): Promise<SheetRow | null> {
  const [row] = await db.select().from(sheets).where(eq(sheets.id, id));
  return row ?? null;
}

/** Metadata only — for the routes that just need to authorize against the project. */
export async function getSheetSummary(id: number): Promise<SheetSummary | null> {
  const [row] = await db.select(SUMMARY_COLUMNS).from(sheets).where(eq(sheets.id, id));
  return row ?? null;
}

export async function createSheet(input: {
  projectId: number;
  title: string;
  data?: string;
  userId: number;
}): Promise<SheetRow> {
  const [{ id }] = await db
    .insert(sheets)
    .values({
      projectId: input.projectId,
      title: input.title,
      // Empty rather than a fabricated snapshot: the client builds the initial
      // workbook, and a server-side guess at Univer's shape would be a second
      // copy of its schema that drifts on every upgrade.
      data: input.data ?? '',
      createdBy: input.userId,
    })
    .$returningId();
  const row = await getSheet(id);
  if (!row) throw new Error('sheet insert failed');
  return row;
}

export async function updateSheet(
  id: number,
  userId: number,
  patch: { title?: string; data?: string },
): Promise<SheetRow | null> {
  if (!(await getSheetSummary(id))) return null;
  await db.update(sheets).set({ ...patch, updatedBy: userId }).where(eq(sheets.id, id));
  return getSheet(id);
}

export async function deleteSheet(id: number): Promise<void> {
  await db.delete(sheets).where(eq(sheets.id, id));
}

/**
 * Is this a workbook snapshot?
 *
 * Deliberately shallow, for the reason given on the `data` column: the snapshot
 * belongs to Univer, and any structure asserted here would be a second copy of
 * its schema. What the server does need to guarantee is that the column holds
 * parseable JSON, so a corrupt write cannot make a sheet permanently unopenable.
 */
export function isWorkbookSnapshot(data: string): boolean {
  if (data === '') return true; // a sheet that has never been saved
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Who may write to a sheet right now.
 *
 * v1 concurrency is a single editor holding a lock, with everyone else watching
 * live — real co-editing is a paid Univer plugin, and the master plan routes
 * around it deliberately.
 *
 * In memory, not in the database, because the lock's lifetime is a socket's
 * lifetime: it must vanish when a browser tab closes, and a row cannot notice
 * that. `releaseAllFor` is wired to socket disconnect for exactly that reason —
 * without it, one crashed tab would leave a sheet read-only for everyone until
 * someone restarted the server.
 *
 * The consequence to know: this is per-process. Multiple API instances would
 * each keep their own locks, so scaling out needs this moved behind Redis (the
 * same conversation as the Socket.IO adapter — see the master plan's scale-out
 * risk).
 */
export interface SheetLock {
  sheetId: number;
  userId: number;
  displayName: string;
  socketId: string;
  acquiredAt: number;
}

const locks = new Map<number, SheetLock>();

export function getLock(sheetId: number): SheetLock | null {
  return locks.get(sheetId) ?? null;
}

/**
 * Take the lock, or report who holds it.
 *
 * Re-acquiring your own lock from the same socket succeeds — a client that
 * reconnects its editor should not deadlock itself out of a sheet it is editing.
 */
export function acquireLock(
  sheetId: number,
  holder: { userId: number; displayName: string; socketId: string },
): { ok: true; lock: SheetLock } | { ok: false; lock: SheetLock } {
  const existing = locks.get(sheetId);
  if (existing && existing.socketId !== holder.socketId) return { ok: false, lock: existing };
  const lock: SheetLock = { sheetId, ...holder, acquiredAt: Date.now() };
  locks.set(sheetId, lock);
  return { ok: true, lock };
}

/** Only the holder's socket can release; returns whether anything was released. */
export function releaseLock(sheetId: number, socketId: string): boolean {
  const existing = locks.get(sheetId);
  if (!existing || existing.socketId !== socketId) return false;
  locks.delete(sheetId);
  return true;
}

/** Every lock a disconnecting socket held. Called from the socket layer. */
export function releaseAllFor(socketId: string): number[] {
  const released: number[] = [];
  for (const [sheetId, lock] of locks) {
    if (lock.socketId === socketId) {
      locks.delete(sheetId);
      released.push(sheetId);
    }
  }
  return released;
}

/** May this user save right now? Nobody holding it counts as free. */
export function canWrite(sheetId: number, userId: number): boolean {
  const lock = locks.get(sheetId);
  return !lock || lock.userId === userId;
}

/** Test-only: locks outlive a database truncation, so resetDb has to clear them. */
export function resetLocks(): void {
  locks.clear();
}
