import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createNote, deleteNote, listNotes, updateNote } from './api';
import type { Note } from './types';

export function NotesPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['notes', q], queryFn: () => listNotes(q || undefined) });
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const selected = data?.notes.find((n) => n.id === selectedId);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notes'] });

  const create = useMutation({
    mutationFn: () => createNote('Untitled'),
    onSuccess: (res) => {
      invalidate();
      setSelectedId(res.note.id);
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteNote(id),
    onSuccess: () => {
      setSelectedId(null);
      invalidate();
    },
  });

  return (
    <div className="flex h-full">
      <div className="w-64 border-r p-2">
        <div className="mb-2 flex gap-2">
          <Input placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button size="sm" onClick={() => create.mutate()}>
            +
          </Button>
        </div>
        <ul className="grid gap-1">
          {data?.notes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${
                  selectedId === n.id ? 'bg-muted' : ''
                }`}
                onClick={() => setSelectedId(n.id)}
              >
                {n.pinned ? '📌 ' : ''}
                {n.title}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex-1 p-4">
        {selected ? (
          <NoteEditor key={selected.id} note={selected} onSaved={invalidate} onDelete={() => remove.mutate(selected.id)} />
        ) : (
          <p className="text-sm text-muted-foreground">Select or create a note.</p>
        )}
      </div>
    </div>
  );
}

function NoteEditor({
  note,
  onSaved,
  onDelete,
}: {
  note: Note;
  onSaved: () => void;
  onDelete: () => void;
}) {
  // Remounted (via the parent's `key={note.id}`) whenever the selected note
  // changes, so this initial state is always fresh — no sync effect needed.
  const [content, setContent] = useState(note.content);

  const save = useMutation({
    mutationFn: () => updateNote(note.id, { content }),
    onSuccess: onSaved,
  });
  const togglePin = useMutation({
    mutationFn: () => updateNote(note.id, { pinned: !note.pinned }),
    onSuccess: onSaved,
  });

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => togglePin.mutate()}>
          {note.pinned ? 'Unpin' : 'Pin'}
        </Button>
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
        <Button variant="destructive" size="sm" onClick={onDelete}>
          Delete
        </Button>
      </div>
      <textarea
        className="flex-1 resize-none rounded-md border bg-background p-3 text-sm outline-none"
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
    </div>
  );
}
