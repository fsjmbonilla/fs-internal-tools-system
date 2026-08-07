import { canPreview } from '@/features/office/previewable';
import type { DriveFile } from './api';

/**
 * What each Google-native type becomes when the server exports it — kept out
 * of the component files so importing the predicate stays Fast-Refresh-safe
 * (the previewable.ts pattern).
 */
export const NATIVE_EXPORT_MIME: Record<string, string> = {
  'application/vnd.google-apps.document':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.spreadsheet':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation': 'application/pdf',
};

/** Files the in-app renderer can take — Google-native or a previewable upload type. */
export function canPreviewDriveFile(file: DriveFile): boolean {
  return file.mimeType in NATIVE_EXPORT_MIME || canPreview(file.mimeType);
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type DriveEditorKind = 'sheet' | 'doc';

/**
 * Files the in-app editor can round-trip, and which editor takes them.
 *
 * - 'sheet': a Google Sheet or a plain .xlsx — both load via the xlsx export
 *   and save back as xlsx bytes (Drive converts them into the Sheet in place;
 *   a plain xlsx is simply replaced).
 * - 'doc': a Google Doc — loads via the docx export, edits as markdown, and
 *   saves back as text/markdown, which Drive converts into the Doc.
 *
 * Plain .docx is deliberately absent: mammoth is one-way (docx → markdown),
 * and writing markdown bytes into a .docx would corrupt it — only a
 * Google-native target gets Drive's conversion on update.
 */
export function driveEditorKind(file: DriveFile): DriveEditorKind | null {
  if (file.isFolder) return null;
  if (file.mimeType === 'application/vnd.google-apps.spreadsheet' || file.mimeType === XLSX_MIME) {
    return 'sheet';
  }
  if (file.mimeType === 'application/vnd.google-apps.document') return 'doc';
  return null;
}
