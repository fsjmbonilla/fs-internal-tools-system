import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments, messages, projectDriveFolders, projectMembers, users } from '../db/schema/index.js';
import { AppError } from '../middleware/errorHandler.js';
import { channelForWriting, projectForWriting, type Caller } from './access.js';
import { getGooglePort, type DriveFile, type DriveListResult } from './google/port.js';
import { requireConnection, withGoogle } from './googleService.js';
import { getDoc } from './docService.js';
import { isEmailAllowed } from './settingsService.js';
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
  opts: { folderId?: string; q?: string; pageToken?: string; sharedWithMe?: boolean },
): Promise<DriveListResult> {
  return withDrive(userId, (token) => getGooglePort().listDriveFiles(token, opts));
}

export function getFile(userId: number, fileId: string): Promise<DriveFile | null> {
  return withDrive(userId, (token) => getGooglePort().getDriveFile(token, fileId));
}

/**
 * Share a Drive file with a colleague, from inside the app. The grant target
 * must be a REGISTERED, ACTIVE app user on an allowed workspace domain — this
 * is an internal tool, not a general share sheet, so an arbitrary outside
 * email is rejected before Google is ever asked.
 */
export async function shareFile(
  callerUserId: number,
  fileId: string,
  input: { email: string; role: 'reader' | 'writer' },
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  if (!(await isEmailAllowed(email))) {
    throw new AppError(400, 'domain_not_allowed', 'That email is not on an allowed workspace domain');
  }
  const [target] = await db
    .select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(eq(users.email, email));
  if (!target || !target.isActive) {
    throw new AppError(400, 'not_registered', 'That email is not a registered user of this app');
  }
  await withDrive(callerUserId, (token) =>
    getGooglePort().shareDriveFile(token, fileId, { email, role: input.role }),
  );
}

/** Drag a file onto a folder in the browser: re-parent it in Drive. */
export function moveFile(userId: number, fileId: string, toFolderId: string): Promise<void> {
  return withDrive(userId, (token) => getGooglePort().moveDriveFile(token, fileId, toFolderId));
}

/** Drag-and-drop into My Drive: create the file in the caller's own Drive. */
export function uploadPersonalFile(
  userId: number,
  input: { folderId?: string; name: string; mimeType: string; data: Buffer },
): Promise<DriveFile> {
  return withDrive(userId, (token) =>
    getGooglePort().uploadDriveFile(token, {
      folderId: input.folderId ?? 'root',
      name: input.name,
      mimeType: input.mimeType,
      data: input.data,
    }),
  );
}

/** Same ceiling as uploads — an export is not a way around the 20MB cap. */
const EXPORT_MAX_BYTES = 20 * 1024 * 1024;

export async function exportFile(
  userId: number,
  fileId: string,
): Promise<{ name: string; mimeType: string; data: Buffer } | null> {
  const exported = await withDrive(userId, (token) =>
    getGooglePort().exportDriveFile(token, fileId),
  );
  if (!exported) return null;
  if (exported.data.byteLength > EXPORT_MAX_BYTES) {
    throw new AppError(413, 'file_too_large', 'That file is too large to preview in-app');
  }
  return exported;
}

/**
 * Overwrite a Drive file's content in place, on the caller's own connection.
 * When the target is Google-native, Drive CONVERTS the uploaded media on
 * update — xlsx bytes sent to a google-apps.spreadsheet id update the Sheet,
 * markdown sent to a google-apps.document updates the Doc — which is what lets
 * the app's own editors save back without speaking the native formats.
 *
 * The name is deliberately kept as-is: a content save is not a rename, so the
 * current name is fetched and passed through unless the caller supplies one.
 */
export async function updateFileContent(
  userId: number,
  fileId: string,
  input: { name?: string; mimeType: string; data: Buffer },
): Promise<DriveFile> {
  const current = await getFile(userId, fileId);
  if (!current) throw new AppError(404, 'not_found', 'Not found');
  if (current.isFolder) {
    throw new AppError(400, 'not_a_file', 'Folders have no content to update');
  }
  await withDrive(userId, (token) =>
    getGooglePort().updateDriveFile(token, fileId, {
      name: input.name ?? current.name,
      mimeType: input.mimeType,
      data: input.data,
    }),
  );
  const refreshed = await getFile(userId, fileId);
  if (!refreshed) throw new AppError(404, 'not_found', 'Not found');
  return refreshed;
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
  if (targets > 1) {
    throw new AppError(400, 'validation_error', 'At most one of messageId, taskId, docId');
  }
  // Zero targets is the composer flow: the row starts unlinked (like an upload)
  // and message send links it through the same linkAttachment gate — owner
  // only, once only. Abandoned rows are ordinary GC food.

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
