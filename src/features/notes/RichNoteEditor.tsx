import { Image } from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/features/auth/authStore';
import { fileUrl, uploadFiles } from '@/lib/uploads';
import { attachNoteFiles } from './api';
import { referencedAttachmentIds, toDisplayDoc, toStoredDoc, type DocNode } from './richDoc';

/**
 * The rich note editor.
 *
 * Stores ProseMirror JSON, never HTML — the server refuses content under
 * `format: 'rich'` that is not a document, and HTML could not pass that check
 * anyway. Images live as `fs-attachment:<id>` references and are resolved to
 * object URLs for display; see `richDoc.ts` for why.
 *
 * StarterKit v3 already bundles Link and Underline, so adding either separately
 * would register a duplicate extension name and throw at mount. Only Image and
 * TableKit are extra.
 */

// StarterKit's link, configured rather than replaced.
const EXTENSIONS = [
  StarterKit.configure({
    link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow' } },
  }),
  Image,
  TableKit,
];

async function fetchObjectUrl(id: number): Promise<string> {
  const token = useAuthStore.getState().accessToken;
  const res = await fetch(fileUrl(id), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`attachment ${id} could not be loaded`);
  return URL.createObjectURL(await res.blob());
}

export function RichNoteEditor({
  noteId,
  initialDoc,
  onDirty,
  editorRef,
}: {
  noteId: number;
  initialDoc: DocNode | null;
  onDirty: () => void;
  /** Lets the parent read the current document when it saves. */
  editorRef: React.MutableRefObject<(() => DocNode | null) | null>;
}) {
  // id → object URL, for both directions of the rewrite. A ref because the
  // save path reads it outside React's render cycle.
  const urls = useRef(new Map<number, string>());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  /**
   * The document to load, captured once.
   *
   * This must not be read from the prop inside the effect. `initialDoc` is parsed
   * fresh on every parent render, so it is a new object each time — an effect
   * depending on it re-ran whenever the parent re-rendered (the first keystroke
   * alone does it, via the dirty flag) and called setContent, wiping whatever had
   * been typed. `loaded` makes the load happen exactly once per mount, and the
   * parent already remounts this component per note.
   *
   * `loaded` is cleared by the effect's cleanup, which StrictMode makes
   * essential rather than tidy: it mounts, unmounts and remounts every component
   * in development. A guard that survived the unmount left the first run
   * cancelled and the second run skipped, so a saved note opened blank — with no
   * error anywhere, because nothing had failed.
   */
  const initial = useRef(initialDoc);
  const loaded = useRef(false);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: undefined, // set once the images resolve, below
    onUpdate: onDirty,
    editorProps: {
      attributes: {
        class: 'fs-rich min-h-full',
        'aria-label': 'Note body',
      },
    },
  });

  // Resolve referenced images, then load the document. Doing it in this order
  // means the editor never briefly shows broken images.
  useEffect(() => {
    if (!editor || loaded.current) return;
    loaded.current = true;
    let cancelled = false;
    const created: string[] = [];

    (async () => {
      const ids = referencedAttachmentIds(initial.current);
      const resolved = new Map<number, string>();
      await Promise.all(
        ids.map(async (id) => {
          try {
            const url = await fetchObjectUrl(id);
            created.push(url);
            resolved.set(id, url);
          } catch {
            // Leave the reference in place — see toDisplayDoc.
          }
        }),
      );
      if (cancelled) {
        for (const url of created) URL.revokeObjectURL(url);
        return;
      }
      urls.current = resolved;
      editor.commands.setContent((toDisplayDoc(initial.current, resolved) ?? { type: 'doc' }) as object);
      setReady(true);
    })();

    return () => {
      cancelled = true;
      loaded.current = false;
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [editor]);

  // Hand the parent a getter rather than the document itself, so it reads the
  // current state at the moment it saves.
  useEffect(() => {
    editorRef.current = () =>
      editor ? toStoredDoc(editor.getJSON() as DocNode, urls.current) : null;
    return () => {
      editorRef.current = null;
    };
  }, [editor, editorRef]);

  const insertImage = useCallback(
    async (file: File) => {
      setError(null);
      setUploading(true);
      try {
        const { attachments, rejected } = await uploadFiles([file]);
        if (attachments.length === 0) {
          throw new Error(rejected[0]?.reason ?? 'That file was not accepted');
        }
        const uploaded = attachments[0];
        // Link it to the note before inserting: an attachment nobody claims is
        // swept by the GC, which would empty the image out from under the note.
        await attachNoteFiles(noteId, [uploaded.id]);
        const url = await fetchObjectUrl(uploaded.id);
        urls.current.set(uploaded.id, url);
        editor?.chain().focus().setImage({ src: url, alt: uploaded.fileName }).run();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not add that image');
      } finally {
        setUploading(false);
      }
    },
    [editor, noteId],
  );

  if (!editor) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Toolbar editor={editor} onPickImage={insertImage} uploading={uploading} />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background p-3">
        <EditorContent editor={editor} />
        {!ready && <p className="text-xs text-muted-foreground">Loading…</p>}
      </div>
    </div>
  );
}

function Toolbar({
  editor,
  onPickImage,
  uploading,
}: {
  editor: Editor;
  onPickImage: (file: File) => void;
  uploading: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * `onMouseDown` preventDefault is what keeps the caret in the document.
   *
   * Without it the button takes focus on mousedown, so the selection the command
   * is about to act on is gone and — worse — the next thing typed goes to the
   * button instead of the note. Observed directly: after clicking Bold, a whole
   * typed sentence landed nowhere and the following Enter re-triggered the button.
   */
  const item = (label: string, isActive: boolean, run: () => void, title: string) => (
    <Button
      key={label}
      type="button"
      variant={isActive ? 'default' : 'outline'}
      size="sm"
      title={title}
      aria-pressed={isActive}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </Button>
  );

  return (
    <div className="flex flex-wrap items-center gap-1">
      {item('B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'Bold')}
      {item('I', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), 'Italic')}
      {item(
        'H2',
        editor.isActive('heading', { level: 2 }),
        () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        'Heading',
      )}
      {item('•', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), 'Bullet list')}
      {item('1.', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), 'Numbered list')}
      {item('</>', editor.isActive('codeBlock'), () => editor.chain().focus().toggleCodeBlock().run(), 'Code block')}
      {item('❝', editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), 'Quote')}
      {item(
        'Link',
        editor.isActive('link'),
        () => {
          if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
            return;
          }
          const href = window.prompt('Link URL');
          if (!href) return;
          // Only http(s): a javascript: URL here would be stored in the document
          // and run on click for whoever opens the note next.
          if (!/^https?:\/\//i.test(href)) {
            window.alert('Links must start with http:// or https://');
            return;
          }
          editor.chain().focus().setLink({ href }).run();
        },
        'Link',
      )}
      {item('Table', editor.isActive('table'), () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), 'Insert table')}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={uploading}
        title="Insert image"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => fileInput.current?.click()}
      >
        {uploading ? 'Uploading…' : 'Image'}
      </Button>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        aria-label="Insert image"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset first, so picking the same file twice in a row still fires.
          e.target.value = '';
          if (file) onPickImage(file);
        }}
      />
    </div>
  );
}
