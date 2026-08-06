import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, messages, projectDriveFolders, projectMembers } from '../db/schema/index.js';
import { AppError } from '../middleware/errorHandler.js';
import { channelForWriting, projectForWriting, type Caller } from './access.js';
import { getGooglePort, type DriveFile, type DriveListResult } from './google/port.js';
import { requireConnection, withGoogle } from './googleService.js';
import { getDoc } from './docService.js';
import { getTaskById } from './taskService.js';

/**
 * Google Drive, always through the acting user's own connection — a project's
 * folder binding stores ids, never tokens, so "the project's files" are only
 * ever read with the credentials of whoever is looking.
 *
 * One wrinkle Calendar and Gmail don't have: connections made before Phase 13
 * lack the Drive scopes, and Google answers those calls with a scope 403, not
 * `invalid_grant`. That is not a broken grant (mail and calendar still work),
 * so it gets its own 409 code and the row is left alone — reconnecting (the
 * consent prompt re-issues everything) is the whole fix.
 */

function isInsufficientScope(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 403 && /insufficient/i.test(e?.message ?? '');
}

async function withDrive<T>(userId: number, fn: (refreshToken: string) => Promise<T>): Promise<T> {
  const account = await requireConnection('user', userId);
  try {
    return await withGoogle(account, fn);
  } catch (err) {
    if (isInsufficientScope(err)) {
      throw new AppError(
        409,
        'google_drive_scope_missing',
        'This Google connection predates Drive access — reconnect in Settings to grant it',
      );
    }
    throw err;
  }
}

export function listFiles(
  userId: number,
  opts: { folderId?: string; q?: string; pageToken?: string },
): Promise<DriveListResult> {
  return withDrive(userId, (token) => getGooglePort().listDriveFiles(token, opts));
}

export function getFile(userId: number, fileId: string): Promise<DriveFile | null> {
  return withDrive(userId, (token) => getGooglePort().getDriveFile(token, fileId));
}

// ─── Project folder binding ──────────────────────────────────────────────────

async function isProjectLead(projectId: number, userId: number): Promise<boolean> {
  const [row] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return row?.role === 'lead';
}

/** Bind — caller must see the project, be its lead (or admin), and the id must be a folder. */
export async function bindProjectFolder(projectId: number, folderId: string, caller: Caller) {
  if (!(await projectForWriting(projectId, caller))) {
    throw new AppError(404, 'not_found', 'Not found');
  }
  if (!caller.isAdmin && !(await isProjectLead(projectId, caller.userId))) {
    throw new AppError(403, 'forbidden', 'Only a project lead can bind a Drive folder');
  }
  const folder = await getFile(caller.userId, folderId);
  if (!folder) throw new AppError(404, 'not_found', 'Not found');
  if (!folder.isFolder) {
    throw new AppError(400, 'not_a_folder', 'That Drive id is a file, not a folder');
  }

  const values = { folderId: folder.id, folderName: folder.name, connectedBy: caller.userId };
  const [existing] = await db
    .select()
    .from(projectDriveFolders)
    .where(eq(projectDriveFolders.projectId, projectId));
  if (existing) {
    await db
      .update(projectDriveFolders)
      .set(values)
      .where(eq(projectDriveFolders.projectId, projectId));
  } else {
    await db.insert(projectDriveFolders).values({ projectId, ...values });
  }
  return { projectId, ...values };
}

/** Unbind. Existing gdrive attachments are references and stay untouched. */
export async function unbindProjectFolder(projectId: number, caller: Caller): Promise<boolean> {
  if (!(await projectForWriting(projectId, caller))) {
    throw new AppError(404, 'not_found', 'Not found');
  }
  if (!caller.isAdmin && !(await isProjectLead(projectId, caller.userId))) {
    throw new AppError(403, 'forbidden', 'Only a project lead can unbind a Drive folder');
  }
  const result = await db
    .delete(projectDriveFolders)
    .where(eq(projectDriveFolders.projectId, projectId));
  return result[0].affectedRows > 0;
}

export async function getProjectFolder(projectId: number) {
  const [row] = await db
    .select()
    .from(projectDriveFolders)
    .where(eq(projectDriveFolders.projectId, projectId));
  return row ?? null;
}

/** Browse inside the bound folder (or a subfolder of it) with the caller's token. */
export async function listProjectFiles(
  projectId: number,
  caller: Caller,
  opts: { folderId?: string; pageToken?: string },
): Promise<DriveListResult & { folder: { id: string; name: string } }> {
  // Visibility only — reading the Files tab is reading the project.
  const binding = await getProjectFolder(projectId);
  if (!binding) throw new AppError(404, 'no_drive_folder', 'This project has no Drive folder');
  return {
    folder: { id: binding.folderId, name: binding.folderName },
    ...(await listFiles(caller.userId, {
      folderId: opts.folderId ?? binding.folderId,
      pageToken: opts.pageToken,
    })),
  };
}

export async function uploadProjectFile(
  projectId: number,
  caller: Caller,
  input: { name: string; mimeType: string; data: Buffer },
): Promise<DriveFile> {
  const binding = await getProjectFolder(projectId);
  if (!binding) throw new AppError(404, 'no_drive_folder', 'This project has no Drive folder');
  return withDrive(caller.userId, (token) =>
    getGooglePort().uploadDriveFile(token, { folderId: binding.folderId, ...input }),
  );
}

// ─── Attach-from-Drive ───────────────────────────────────────────────────────

/**
 * Attach a Drive file as a reference chip. The metadata is fetched server-side
 * with the caller's token (never trusted from the client), and the row is
 * created already linked — unlike uploads there is no unlinked stage, because
 * there are no bytes to stage.
 */
export async function attachFromDrive(
  caller: Caller,
  driveFileId: string,
  target: { messageId?: number; taskId?: number; docId?: number },
) {
  const targets = [target.messageId, target.taskId, target.docId].filter(
    (t) => t !== undefined,
  ).length;
  if (targets !== 1) {
    throw new AppError(400, 'validation_error', 'Exactly one of messageId, taskId, docId');
  }

  // The caller must be able to WRITE where the chip lands — same bar as
  // posting the message or editing the task would demand. Notes are absent on
  // purpose, as everywhere agents and integrations reach.
  if (target.messageId !== undefined) {
    const [message] = await db.select().from(messages).where(eq(messages.id, target.messageId));
    if (!message || !(await channelForWriting(message.channelId, caller))) {
      throw new AppError(404, 'not_found', 'Not found');
    }
  } else if (target.taskId !== undefined) {
    const task = await getTaskById(target.taskId);
    if (!task || !(await projectForWriting(task.projectId, caller))) {
      throw new AppError(404, 'not_found', 'Not found');
    }
  } else if (target.docId !== undefined) {
    const doc = await getDoc(target.docId);
    if (!doc || !(await projectForWriting(doc.projectId, caller))) {
      throw new AppError(404, 'not_found', 'Not found');
    }
  }

  const file = await getFile(caller.userId, driveFileId);
  if (!file) throw new AppError(404, 'not_found', 'Not found');
  if (file.isFolder) {
    throw new AppError(400, 'not_a_file', 'Folders cannot be attached — attach a file');
  }

  const [{ id }] = await db
    .insert(attachments)
    .values({
      uploaderId: caller.userId,
      provider: 'gdrive',
      driveFileId: file.id,
      webViewLink: file.webViewLink,
      iconMime: file.mimeType,
      fileName: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes ?? 0,
      ...target,
    })
    .$returningId();
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
  return row;
}
