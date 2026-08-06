import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Markdown } from '@/features/docs/Markdown';
import { createNote, deleteNote, listNotes, updateNote } from './api';
import { MoveToProjectDialog } from './MoveToProjectDialog';
import { RichNoteEditor } from './RichNoteEditor';
import type { DocNode } from './richDoc';
import type { Note } from './types';

/** Parse stored rich content, tolerating a row that somehow is not a document. */
function parseDoc(content: string): DocNode | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? (parsed as DocNode) : null;
  } catch {
    return null;
  }
}

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
  const [title, setTitle] = useState(note.title);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRich = note.format === 'rich';
  // A rich note's body lives in the editor, not in React state — reading it on
  // every keystroke would re-render the page for each character typed.
  const readDoc = useRef<(() => DocNode | null) | null>(null);
  const [dirty, setDirty] = useState(false);

  const save = useMutation({
    // The title was never part of this payload, so every note kept the
    // 'Untitled' it was created with. A blank title saves as 'Untitled' rather
    // than failing the API's min-length rule and losing the content edit.
    mutationFn: () => {
      const base = { title: title.trim() || 'Untitled' };
      if (!isRich) return updateNote(note.id, { ...base, content });
      const doc = readDoc.current?.() ?? { type: 'doc', content: [] };
      return updateNote(note.id, { ...base, content: JSON.stringify(doc), format: 'rich' });
    },
    onSuccess: () => {
      setError(null);
      setDirty(false);
      onSaved();
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not save the note'),
  });
  const togglePin = useMutation({
    mutationFn: () => updateNote(note.id, { pinned: !note.pinned }),
    onSuccess: onSaved,
  });

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          className="border-0 px-0 text-base font-semibold shadow-none focus-visible:ring-0"
          value={title}
          placeholder="Untitled"
          aria-label="Note title"
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save.mutate();
            }
          }}
        />
        {/* A rich note is already WYSIWYG — there is nothing for a preview to reveal. */}
        {!isRich && (
          <Button variant="outline" size="sm" onClick={() => setPreview((v) => !v)}>
            {preview ? 'Edit' : 'Preview'}
          </Button>
        )}
        <MoveToProjectDialog noteId={note.id} noteTitle={note.title} />
        <Button variant="outline" size="sm" onClick={() => togglePin.mutate()}>
          {note.pinned ? 'Unpin' : 'Pin'}
        </Button>
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : dirty ? 'Save •' : 'Save'}
        </Button>
        <Button variant="destructive" size="sm" onClick={onDelete}>
          Delete
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {isRich ? (
        <RichNoteEditor
          noteId={note.id}
          initialDoc={parseDoc(note.content)}
          // Only the false→true transition matters; setting it on every keystroke
          // would re-render this page for each character typed.
          onDirty={() => setDirty((d) => d || true)}
          editorRef={readDoc}
        />
      ) : preview ? (
        <div className="flex-1 overflow-auto rounded-md border p-3">
          <Markdown content={content} />
        </div>
      ) : (
        <textarea
          className="flex-1 resize-none rounded-md border bg-background p-3 font-mono text-sm outline-none"
          value={content}
          placeholder="Markdown — # headings, **bold**, - lists, `code`"
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
          }}
        />
      )}
    </div>
  );
}
