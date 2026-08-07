import { api, apiUpload } from '@/lib/api';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  webViewLink: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  owner: string | null;
  thumbnailLink: string | null;
  shared: boolean;
  imageWidth: number | null;
  imageHeight: number | null;
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

/** Drag a file onto a folder: re-parent it in Drive. */
export const moveDriveFile = (fileId: string, folderId: string) =>
  api<{ ok: boolean }>(`/api/drive/files/${encodeURIComponent(fileId)}/move`, {
    method: 'POST',
    body: { folderId },
  });

/** Share with a registered colleague; the server validates domain + registration. */
export const shareDriveFile = (fileId: string, email: string, role: 'reader' | 'writer') =>
  api<{ ok: boolean }>(`/api/drive/files/${encodeURIComponent(fileId)}/share`, {
    method: 'POST',
    body: { email, role },
  });

/** Drag-and-drop upload into the caller's own Drive. */
export const uploadToMyDrive = (file: File, folderId?: string) => {
  const form = new FormData();
  form.append('file', file);
  if (folderId) form.append('folderId', folderId);
  return apiUpload<{ file: DriveFile }>('/api/drive/files', form);
};

/**
 * Overwrite a Drive file's content in place. When the target is Google-native,
 * Drive converts the upload back — xlsx bytes update the Sheet, markdown
 * updates the Doc — so the file keeps its id, name and type. The server keeps
 * the current name regardless of the part's filename.
 */
export const updateDriveFileContent = (fileId: string, data: Blob, fileName: string) => {
  const form = new FormData();
  form.append('file', new File([data], fileName, { type: data.type }));
  return apiUpload<{ file: DriveFile }>(
    `/api/drive/files/${encodeURIComponent(fileId)}/content`,
    form,
    'PUT',
  );
};

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
