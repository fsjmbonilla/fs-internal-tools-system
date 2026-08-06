import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { attachFromDrive, listDriveFiles, type DriveAttachment, type DriveFile } from './api';
import { DriveBrowser } from './DriveBrowser';

/**
 * The in-app Drive picker (deliberately not Google Picker JS — see the Phase 13
 * plan). Pick a file; it becomes a reference chip. `target` empty means the
 * composer flow: the attachment starts unlinked and the message links it at
 * send time, exactly like an upload.
 */
export function AttachFromDriveDialog({
  open,
  onOpenChange,
  target,
  onAttached,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target?: { taskId?: number; docId?: number };
  onAttached: (attachment: DriveAttachment) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: (file: DriveFile) => attachFromDrive(file.id, target ?? {}),
    onSuccess: ({ attachment }) => {
      setError(null);
      onOpenChange(false);
      onAttached(attachment);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not attach'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Attach from Drive</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          This attaches a link, not a copy — Drive keeps its own permissions, so someone
          without access to the file in Google may still have to request it there.
        </p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="min-h-0 flex-1">
          <DriveBrowser
            rootName="My Drive"
            fetchPage={listDriveFiles}
            searchable
            onPickFile={(file) => attach.mutate(file)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
