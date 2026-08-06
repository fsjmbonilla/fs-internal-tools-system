import { api } from '@/lib/api';
import type { Note } from './types';

export const listNotes = (q?: string) => {
  const params = q ? `?q=${encodeURIComponent(q)}` : '';
  return api<{ notes: Note[] }>(`/api/notes${params}`);
};

/**
 * New notes are rich documents. Existing markdown notes keep their format and
 * their renderer — nothing converts them, because a converter could only guess
 * at what the markdown meant.
 */
export const createNote = (title: string) =>
  api<{ note: Note }>('/api/notes', {
    method: 'POST',
    body: { title, content: JSON.stringify({ type: 'doc', content: [] }), format: 'rich' },
  });

export const updateNote = (
  id: number,
  patch: Partial<Pick<Note, 'title' | 'content' | 'pinned' | 'format'>>,
) => api<{ note: Note }>(`/api/notes/${id}`, { method: 'PATCH', body: patch });

/** Link already-uploaded files to a note. Owner-only, like everything about notes. */
export const attachNoteFiles = (id: number, attachmentIds: number[]) =>
  api<{ note: Note }>(`/api/notes/${id}/attachments`, {
    method: 'POST',
    body: { attachmentIds },
  });

export const deleteNote = (id: number) => api(`/api/notes/${id}`, { method: 'DELETE' });

/**
 * Turn a personal note into a project document.
 *
 * This is how a note reaches other people. Notes themselves are deliberately
 * private — the server documents that — so sharing means moving the content
 * somewhere sharing already exists, where project membership decides who can
 * read and edit it. The note is consumed in the process.
 */
export const convertNoteToDoc = (id: number, projectId: number) =>
  api<{ doc: { id: number; projectId: number; title: string } }>(
    `/api/notes/${id}/convert-to-doc`,
    { method: 'POST', body: { projectId } },
  );
