import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Pin, Plus } from 'lucide-react';
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
  const { data, isLoading } = useQuery({
    queryKey: ['notes', q],
    queryFn: () => listNotes(q || undefined),
  });
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
    <div className="flex h-full min-h-0">
      {/* On phones the list and the editor take turns; md+ shows both panes. */}
      <div
        className={`${selected ? 'hidden md:flex' : 'flex'} w-full min-h-0 flex-col border-r p-2 md:w-64`}
      >
        <div className="mb-2 flex gap-2">
          <Input placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button
            size="sm"
            className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
            aria-label="New note"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            <Plus />
          </Button>
        </div>
        {isLoading && (
          <div className="space-y-1" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-11 animate-pulse rounded-md bg-muted md:h-8" />
            ))}
          </div>
        )}
        {!isLoading && data?.notes.length === 0 && (
          <p className="px-2 py-1 text-sm text-muted-foreground">
            {q ? `No notes match “${q}”.` : 'No notes yet — the + button creates one.'}
          </p>
        )}
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {data?.notes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={`flex min-h-11 w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-accent md:min-h-8 ${
                  selectedId === n.id ? 'bg-accent font-medium' : ''
                }`}
                onClick={() => setSelectedId(n.id)}
              >
                {n.pinned && (
                  <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pinned" />
                )}
                <span className="truncate">{n.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className={`${selected ? 'flex' : 'hidden md:flex'} min-h-0 flex-1 flex-col p-4`}>
        {selected ? (
          <NoteEditor
            key={selected.id}
            note={selected}
            onSaved={invalidate}
            onBack={() => setSelectedId(null)}
            onDelete={() => {
              if (window.confirm(`Delete “${selected.title}”?`)) remove.mutate(selected.id);
            }}
          />
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
  onBack,
  onDelete,
}: {
  note: Note;
  onSaved: () => void;
  /** Phone-only: return to the list pane. */
  onBack: () => void;
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
    <div className="flex h-full min-h-0 flex-col gap-2 duration-200 animate-in fade-in max-md:slide-in-from-right-8">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 md:hidden"
          aria-label="Back to notes"
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <Input
          className="w-auto min-w-32 flex-1 border-0 px-0 text-base font-semibold shadow-none focus-visible:ring-0"
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
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-7"
            onClick={() => setPreview((v) => !v)}
          >
            {preview ? 'Edit' : 'Preview'}
          </Button>
        )}
        <MoveToProjectDialog noteId={note.id} noteTitle={note.title} />
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 md:min-h-7"
          onClick={() => togglePin.mutate()}
        >
          {note.pinned ? 'Unpin' : 'Pin'}
        </Button>
        <Button
          size="sm"
          className="min-h-11 md:min-h-7"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : dirty ? 'Save •' : 'Save'}
        </Button>
        <Button variant="destructive" size="sm" className="min-h-11 md:min-h-7" onClick={onDelete}>
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
        <div className="min-h-0 flex-1 overflow-auto rounded-md border p-3">
          <Markdown content={content} />
        </div>
      ) : (
        <textarea
          className="min-h-0 flex-1 resize-none rounded-md border bg-background p-3 font-mono text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
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
