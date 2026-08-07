import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pencil } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FilePreview } from '@/features/office/OfficePreview';
import { fetchAuthedBytes } from '@/lib/uploads';
import type { DriveFile } from './api';
import { DriveFileEditor } from './DriveFileEditor';
import { driveEditorKind, NATIVE_EXPORT_MIME } from './preview';

/**
 * A Google Doc/Sheet picked in the browser renders here, inside the app —
 * the server exports it (docx/xlsx/pdf) and the bytes go through the same
 * client-side pipeline that previews uploaded office files.
 *
 * Editable types (Sheets, Docs, plain xlsx) get an Edit button that swaps
 * this dialog for the full-screen editor. The editor is a sibling of the
 * Dialog, not a child: Univer floats its own popups, and a modal Dialog's
 * focus trap would fight them.
 */
export function DriveFilePreviewDialog({
  file,
  onOpenChange,
}: {
  file: DriveFile | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const fileId = file?.id;
  const [editing, setEditing] = useState(false);
  // Bumped after each save so the preview refetches the new content.
  const [contentVersion, setContentVersion] = useState(0);

  useEffect(() => {
    setEditing(false);
    setContentVersion(0);
  }, [fileId]);

  const loadBytes = useCallback(
    () => fetchAuthedBytes(`/api/drive/files/${encodeURIComponent(fileId ?? '')}/export`),
    [fileId],
  );

  const editorKind = file ? driveEditorKind(file) : null;

  return (
    <>
      <Dialog open={file !== null && !editing} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[92dvh] w-[96vw] max-w-4xl overflow-hidden md:w-full">
          {file && (
            <>
              <DialogHeader>
                <DialogTitle className="flex min-w-0 items-center gap-1 pr-6">
                  <span className="truncate">{file.name}</span>
                  {editorKind && (
                    <button
                      type="button"
                      aria-label="Edit in app"
                      onClick={() => setEditing(true)}
                      className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:min-h-8 md:min-w-8"
                    >
                      <Pencil className="size-4" />
                    </button>
                  )}
                  {file.webViewLink && (
                    <a
                      href={file.webViewLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Open in Google Drive"
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <ExternalLink className="size-4" />
                    </a>
                  )}
                </DialogTitle>
              </DialogHeader>
              <div className="min-h-0 overflow-y-auto">
                <FilePreview
                  key={`${file.id}-${contentVersion}`}
                  loadBytes={loadBytes}
                  fileName={file.name}
                  mimeType={NATIVE_EXPORT_MIME[file.mimeType] ?? file.mimeType}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      {editing && file && editorKind && (
        <DriveFileEditor
          file={file}
          kind={editorKind}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setContentVersion((v) => v + 1);
            void queryClient.invalidateQueries({ queryKey: ['drive-browse'] });
          }}
        />
      )}
    </>
  );
}
