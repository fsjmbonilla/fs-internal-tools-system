import { api } from '@/lib/api';
import type { Note } from './types';

export const listNotes = (q?: string) => {
  const params = q ? `?q=${encodeURIComponent(q)}` : '';
  return api<{ notes: Note[] }>(`/api/notes${params}`);
};

export const createNote = (title: string) =>
  api<{ note: Note }>('/api/notes', { method: 'POST', body: { title, content: '' } });

export const updateNote = (id: number, patch: Partial<Pick<Note, 'title' | 'content' | 'pinned'>>) =>
  api<{ note: Note }>(`/api/notes/${id}`, { method: 'PATCH', body: patch });

export const deleteNote = (id: number) => api(`/api/notes/${id}`, { method: 'DELETE' });
