import { eq } from 'drizzle-orm';
import type { Server, Socket } from 'socket.io';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { getVisibleProject, isProjectMember } from '../services/projectService.js';
import {
  acquireLock,
  getLock,
  getSheetSummary,
  releaseAllFor,
  releaseLock,
} from '../services/sheetService.js';

/**
 * The edit lock, over sockets.
 *
 * A lock has to die with the tab that holds it, which is the whole reason it
 * lives on the socket rather than in a row: `disconnect` is the only reliable
 * signal that an editor has gone away. A crashed browser must not leave a sheet
 * read-only for everyone else until someone restarts the server.
 *
 * Every handler re-checks the sheet's project visibility. A socket event is as
 * much a way into the data as an HTTP route, and joining a room named after a
 * sheet id would otherwise be enough to watch a private project's sheet change.
 */

type Ack = (result: { ok: boolean; [key: string]: unknown }) => void;

async function mayView(socket: Socket, sheetId: number): Promise<number | null> {
  const summary = await getSheetSummary(sheetId);
  if (!summary) return null;
  const project = await getVisibleProject(
    summary.projectId,
    socket.data.userId,
    socket.data.role === 'admin',
  );
  return project ? summary.projectId : null;
}

async function mayEdit(socket: Socket, sheetId: number): Promise<boolean> {
  const projectId = await mayView(socket, sheetId);
  if (projectId === null) return false;
  if (socket.data.role === 'admin') return true;
  return isProjectMember(projectId, socket.data.userId);
}

export function registerSheetHandlers(io: Server, socket: Socket): void {
  socket.on('sheet:watch', async (sheetId: number) => {
    if ((await mayView(socket, sheetId)) === null) return; // silently refuse — no existence leak
    socket.join(`sheet:${sheetId}`);
    socket.emit('sheet:lock', { sheetId, lock: getLock(sheetId) });
  });

  socket.on('sheet:unwatch', (sheetId: number) => {
    socket.leave(`sheet:${sheetId}`);
  });

  socket.on('sheet:lock:acquire', async (sheetId: number, ack?: Ack) => {
    if (!(await mayEdit(socket, sheetId))) {
      ack?.({ ok: false, error: 'not_found' });
      return;
    }
    const [user] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, socket.data.userId));
    const result = acquireLock(sheetId, {
      userId: socket.data.userId,
      displayName: user?.displayName ?? 'Someone',
      socketId: socket.id,
    });
    ack?.({ ok: result.ok, lock: result.lock });
    if (result.ok) io.to(`sheet:${sheetId}`).emit('sheet:lock', { sheetId, lock: result.lock });
  });

  socket.on('sheet:lock:release', (sheetId: number, ack?: Ack) => {
    const released = releaseLock(sheetId, socket.id);
    ack?.({ ok: released });
    if (released) io.to(`sheet:${sheetId}`).emit('sheet:lock', { sheetId, lock: null });
  });

  socket.on('disconnect', () => {
    // The reason the lock lives here at all.
    for (const sheetId of releaseAllFor(socket.id)) {
      io.to(`sheet:${sheetId}`).emit('sheet:lock', { sheetId, lock: null });
    }
  });
}
