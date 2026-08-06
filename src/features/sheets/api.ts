import { api } from '@/lib/api';

export interface SheetLock {
  sheetId: number;
  userId: number;
  displayName: string;
  acquiredAt: number;
}

export interface SheetSummary {
  id: number;
  projectId: number;
  title: string;
  createdBy: number;
  updatedBy: number | null;
  createdAt: string;
  updatedAt: string;
}

/** The full row. `data` is a Univer workbook snapshot, or '' if never saved. */
export type Sheet = SheetSummary & { data: string };

export const listSheets = (projectId: number) =>
  api<{ sheets: SheetSummary[] }>(`/api/projects/${projectId}/sheets`);

export const createSheet = (projectId: number, title: string) =>
  api<{ sheet: SheetSummary }>(`/api/projects/${projectId}/sheets`, {
    method: 'POST',
    body: { title },
  });

export const getSheet = (id: number) =>
  api<{ sheet: Sheet; lock: SheetLock | null }>(`/api/sheets/${id}`);

/**
 * Save the workbook. 409 when someone else holds the edit lock — the caller has
 * to surface that rather than retrying, or one editor silently overwrites the
 * other, which is the whole thing the lock prevents.
 */
export const saveSheet = (id: number, patch: { title?: string; data?: string }) =>
  api<{ sheet: SheetSummary; lock: SheetLock | null }>(`/api/sheets/${id}`, {
    method: 'PATCH',
    body: patch,
  });

export const deleteSheet = (id: number) => api(`/api/sheets/${id}`, { method: 'DELETE' });
