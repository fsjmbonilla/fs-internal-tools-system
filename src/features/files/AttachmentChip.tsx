import { useState } from 'react';
import { fileUrl } from '@/lib/uploads';
import { Lightbox } from './Lightbox';

export interface AttachmentInfo {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentChip({ attachment }: { attachment: AttachmentInfo }) {
  const [previewing, setPreviewing] = useState(false);
  const isImage = attachment.mimeType.startsWith('image/');

  return (
    <>
      <button
        type="button"
        onClick={() => (isImage ? setPreviewing(true) : window.open(fileUrl(attachment.id), '_blank'))}
        className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs hover:bg-accent"
      >
        <span className="truncate">{attachment.fileName}</span>
        <span className="text-muted-foreground">{formatSize(attachment.sizeBytes)}</span>
      </button>
      {isImage && (
        <Lightbox attachmentId={previewing ? attachment.id : null} onClose={() => setPreviewing(false)} />
      )}
    </>
  );
}
