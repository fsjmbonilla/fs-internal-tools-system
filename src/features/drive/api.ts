import { api } from '@/lib/api';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  webViewLink: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  owner: string | null;
}

export interface DriveListResult {
  files: DriveFile[];
  nextPageToken: string | null;
}

function browseParams(opts: { folderId?: string; q?: string; pageToken?: string }): string {
  const params = new URLSearchParams();
  if (opts.folderId) params.set('folderId', opts.folderId);
  if (opts.q) params.set('q', opts.q);
  if (opts.pageToken) params.set('pageToken', opts.pageToken);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const listDriveFiles = (opts: { folderId?: string; q?: string; pageToken?: string } = {}) =>
  api<DriveListResult>(`/api/drive/files${browseParams(opts)}`);

export const getProjectDriveFolder = (projectId: number) =>
  api<{ folder: { folderId: string; folderName: string } | null }>(
    `/api/projects/${projectId}/drive-folder`,
  );

export const bindProjectDriveFolder = (projectId: number, folderId: string) =>
  api<{ folder: { folderId: string; folderName: string } }>(
    `/api/projects/${projectId}/drive-folder`,
    { method: 'POST', body: { folderId } },
  );

export const unbindProjectDriveFolder = (projectId: number) =>
  api<{ ok: boolean }>(`/api/projects/${projectId}/drive-folder`, { method: 'DELETE' });

export const listProjectDriveFiles = (
  projectId: number,
  opts: { folderId?: string; pageToken?: string } = {},
) =>
  api<DriveListResult & { folder: { id: string; name: string } }>(
    `/api/projects/${projectId}/drive-files${browseParams(opts)}`,
  );

export interface DriveAttachment {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  provider: 'internal' | 'gdrive';
  webViewLink: string | null;
}

export const attachFromDrive = (
  driveFileId: string,
  target: { messageId?: number; taskId?: number; docId?: number } = {},
) =>
  api<{ attachment: DriveAttachment }>('/api/attachments/from-drive', {
    method: 'POST',
    body: { driveFileId, ...target },
  });
