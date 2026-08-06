export interface NoteAttachment {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface Note {
  id: number;
  title: string;
  content: string;
  /**
   * Which renderer `content` needs. `markdown` is every note written before rich
   * documents existed — kept as a read path rather than migrated, since a
   * converter could only guess. New notes are `rich`: ProseMirror JSON.
   */
  format: 'markdown' | 'rich';
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** Present on a single-note fetch; absent from the list. */
  attachments?: NoteAttachment[];
}
