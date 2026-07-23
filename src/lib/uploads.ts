import { useAuthStore } from '@/features/auth/authStore';

const BASE = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4000';

export interface UploadedFile {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export async function uploadFiles(files: File[]): Promise<UploadedFile[]> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const token = useAuthStore.getState().accessToken;
  const res = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) throw new Error('upload failed');
  const data = await res.json();
  return data.attachments;
}

export function fileUrl(id: number): string {
  return `${BASE}/api/files/${id}`;
}
