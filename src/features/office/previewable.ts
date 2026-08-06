/**
 * Which uploaded files get an in-app preview.
 *
 * Separate from the component so importing this predicate does not drag the
 * preview (and mammoth, and SheetJS) into a caller's chunk — and so the module
 * exports components only, which is what React Fast Refresh needs.
 */
export const PREVIEWABLE = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/pdf',
]);

export function canPreview(mimeType: string): boolean {
  return mimeType.startsWith('image/') || PREVIEWABLE.has(mimeType);
}
