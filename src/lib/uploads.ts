import { useAuthStore } from '@/features/auth/authStore';

const BASE = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4000';

export interface UploadedFile {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface RejectedFile {
  fileName: string;
  reason: string;
}

export interface UploadResult {
  attachments: UploadedFile[];
  rejected: RejectedFile[];
}

/**
 * The server verifies each file's bytes against its declared type and returns
 * whatever it refused. Callers have to show that: the UI renders one chip per
 * accepted file, so a silently dropped file just looks like a file that vanished.
 */
export async function uploadFiles(files: File[]): Promise<UploadResult> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const token = useAuthStore.getState().accessToken;
  const res = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Nothing was stored — surface why, using the server's own list when it sent one.
    throw new Error(rejectionMessage(data?.rejected ?? []) ?? 'Upload failed');
  }
  return { attachments: data.attachments ?? [], rejected: data.rejected ?? [] };
}

/** A short human-readable summary, or null when nothing was rejected. */
export function rejectionMessage(rejected: RejectedFile[]): string | null {
  if (rejected.length === 0) return null;
  const names = rejected.map((r) => r.fileName).join(', ');
  return rejected.length === 1
    ? `${names} was not accepted: ${rejected[0].reason}`
    : `${rejected.length} files were not accepted: ${names}`;
}

export function fileUrl(id: number): string {
  return `${BASE}/api/files/${id}`;
}
