import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { notes } from '../db/schema/index.js';
import { logger } from '../logger.js';
import { events } from '../services/events.js';
import { getGooglePort } from '../services/google/port.js';
import { getConnection, withGoogle } from '../services/googleService.js';

/**
 * Auto-backup: every note save also writes a Markdown copy into a private
 * "FS Notes" folder in the OWNER's own Drive, through the owner's own Google
 * connection.
 *
 * The privacy invariant survives because nothing here widens who can read a
 * note: the copy lands only in the owner's Google account, the event carries
 * ids only, and on any miss (no connection, broken grant, missing scope) the
 * backup is skipped silently — the note itself is never blocked or exposed.
 * Never log note content here, only ids.
 */

const FOLDER_NAME = 'FS Notes';
const DEFAULT_DEBOUNCE_MS = 15_000;

const pending = new Map<number, ReturnType<typeof setTimeout>>();
let off: (() => void) | null = null;

/** Autosave fires per keystroke burst; one Drive write per quiet period is plenty. */
export function registerNoteDriveBackup(opts: { debounceMs?: number } = {}): void {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const handler = ({ noteId, userId }: { noteId: number; userId: number }) => {
    const existing = pending.get(noteId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(noteId);
      backupNote(noteId, userId).catch((err) => {
        logger.warn({ noteId, err: (err as Error).message }, 'note drive backup failed');
      });
    }, debounceMs);
    // A pending backup must not hold the process open.
    timer.unref?.();
    pending.set(noteId, timer);
  };
  events.on('note.saved', handler);
  off = () => events.off('note.saved', handler);
}

/** Tests and resetDb: drop timers (and the listener) that outlive a truncation. */
export function resetNoteDriveBackup(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  off?.();
  off = null;
}

async function backupNote(noteId: number, userId: number): Promise<void> {
  const [note] = await db.select().from(notes).where(eq(notes.id, noteId));
  // Deleted since the save, or transferred — the event's owner no longer holds it.
  if (!note || note.userId !== userId) return;

  const account = await getConnection('user', userId);
  if (!account || account.status !== 'active') return;
  if (!account.scopes.some((s) => s.endsWith('drive.file'))) return;

  const body =
    note.format === 'rich' ? richDocToMarkdown(note.content) : note.content;
  const name = `${(note.title || 'Untitled').replace(/[/\\]/g, '-').slice(0, 120)} (note-${note.id}).md`;
  const data = Buffer.from(body, 'utf8');
  const port = getGooglePort();

  if (note.driveFileId) {
    try {
      await withGoogle(account, (token) =>
        port.updateDriveFile(token, note.driveFileId!, {
          name,
          mimeType: 'text/markdown',
          data,
        }),
      );
      return;
    } catch (err) {
      // The owner deleted the backup in Drive — recreate rather than fail forever.
      if ((err as { status?: number }).status !== 404) throw err;
    }
  }

  const folder = await withGoogle(account, (token) =>
    port.ensureDriveFolder(token, FOLDER_NAME),
  );
  const file = await withGoogle(account, (token) =>
    port.uploadDriveFile(token, {
      folderId: folder.id,
      name,
      mimeType: 'text/markdown',
      data,
    }),
  );
  await db.update(notes).set({ driveFileId: file.id }).where(eq(notes.id, note.id));
}

/**
 * A rich note stores ProseMirror JSON. The backup wants something a person can
 * read in Drive, so this walks the document into plain Markdown. Lossy on
 * purpose (images become placeholders — their bytes live in our storage), but
 * every word survives.
 */
export function richDocToMarkdown(content: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return content;
  }
  return blocks((doc as { content?: PmNode[] }).content ?? []).trim() + '\n';
}

interface PmNode {
  type?: string;
  text?: string;
  attrs?: { level?: number };
  marks?: Array<{ type?: string }>;
  content?: PmNode[];
}

function inline(nodes: PmNode[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '\n';
      if (n.type === 'image') return '![image]';
      let text = n.text ?? '';
      for (const mark of n.marks ?? []) {
        if (mark.type === 'bold') text = `**${text}**`;
        else if (mark.type === 'italic') text = `*${text}*`;
        else if (mark.type === 'code') text = `\`${text}\``;
        else if (mark.type === 'strike') text = `~~${text}~~`;
      }
      return text;
    })
    .join('');
}

function blocks(nodes: PmNode[], indent = ''): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'heading':
          return `${'#'.repeat(n.attrs?.level ?? 1)} ${inline(n.content)}\n\n`;
        case 'paragraph':
          return `${indent}${inline(n.content)}\n\n`;
        case 'bulletList':
          return (n.content ?? [])
            .map((li) => `${indent}- ${blocks(li.content ?? [], '').trim()}\n`)
            .join('') + '\n';
        case 'orderedList':
          return (n.content ?? [])
            .map((li, i) => `${indent}${i + 1}. ${blocks(li.content ?? [], '').trim()}\n`)
            .join('') + '\n';
        case 'blockquote':
          return blocks(n.content ?? [])
            .trim()
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n') + '\n\n';
        case 'codeBlock':
          return '```\n' + inline(n.content) + '\n```\n\n';
        case 'horizontalRule':
          return '---\n\n';
        case 'table':
          return (n.content ?? [])
            .map(
              (row) =>
                '| ' +
                (row.content ?? []).map((cell) => blocks(cell.content ?? []).trim()).join(' | ') +
                ' |\n',
            )
            .join('') + '\n';
        default:
          return n.content ? blocks(n.content, indent) : '';
      }
    })
    .join('');
}
