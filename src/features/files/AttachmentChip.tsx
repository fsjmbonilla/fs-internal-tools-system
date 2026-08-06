import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { OfficePreview } from '@/features/office/OfficePreview';
import { canPreview } from '@/features/office/previewable';
import { fileUrl } from '@/lib/uploads';
import { Lightbox } from './Lightbox';

export interface AttachmentInfo {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Absent on older payload shapes; treated as 'internal'. */
  provider?: 'internal' | 'gdrive';
  webViewLink?: string | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * One attached file.
 *
 * Images keep the existing lightbox. Spreadsheets, Word documents and PDFs now
 * open a read-only preview in the same place rather than being downloaded —
 * everything else still downloads, because a file the browser cannot render is
 * a file the user wanted a copy of.
 */
export function AttachmentChip({ attachment }: { attachment: AttachmentInfo }) {
  const [previewing, setPreviewing] = useState(false);
  const isImage = attachment.mimeType.startsWith('image/');
  const previewable = canPreview(attachment.mimeType);

  // A Drive attachment is a reference — the bytes live in Google, so the chip
  // deep-links there instead of previewing. Drive enforces its own permissions;
  // a viewer without access requests it in Google, which is expected, not broken.
  if (attachment.provider === 'gdrive') {
    return (
      <a
        href={attachment.webViewLink ?? '#'}
        target="_blank"
        rel="noreferrer"
        title="Opens in Google Drive"
        className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs hover:bg-accent"
      >
        <span className="truncate">{attachment.fileName}</span>
        <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">
          Drive
        </span>
      </a>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() =>
          previewable ? setPreviewing(true) : window.open(fileUrl(attachment.id), '_blank')
        }
        title={previewable ? 'Preview' : 'Download'}
        className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs hover:bg-accent"
      >
        <span className="truncate">{attachment.fileName}</span>
        <span className="text-muted-foreground">{formatSize(attachment.sizeBytes)}</span>
      </button>

      {isImage && (
        <Lightbox attachmentId={previewing ? attachment.id : null} onClose={() => setPreviewing(false)} />
      )}

      {!isImage && previewable && previewing && (
        <Dialog open onOpenChange={(open) => !open && setPreviewing(false)}>
          <DialogContent className="max-w-5xl">
            <DialogHeader>
              <DialogTitle className="truncate text-sm">{attachment.fileName}</DialogTitle>
            </DialogHeader>
            <OfficePreview
              attachmentId={attachment.id}
              fileName={attachment.fileName}
              mimeType={attachment.mimeType}
            />
            <a
              href={fileUrl(attachment.id)}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted-foreground underline"
            >
              Download the original
            </a>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
