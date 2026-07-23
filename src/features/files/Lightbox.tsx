import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useAuthStore } from '@/features/auth/authStore';
import { fileUrl } from '@/lib/uploads';

export function Lightbox({
  attachmentId,
  onClose,
}: {
  attachmentId: number | null;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (attachmentId === null) return;
    let objectUrl: string | null = null;
    const token = useAuthStore.getState().accessToken;
    fetch(fileUrl(attachmentId), { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      .then((res) => res.blob())
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      });
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setSrc(null);
    };
  }, [attachmentId]);

  // Unmount the Dialog subtree entirely when closed, rather than toggling its
  // `open` prop on an always-mounted Dialog: the latter leaves a lingering,
  // still-interactive overlay behind if the close animation doesn't fully
  // resolve, silently blocking clicks on whatever is underneath.
  if (attachmentId === null) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        {src && <img src={src} alt="attachment preview" className="max-h-[80vh] w-full object-contain" />}
      </DialogContent>
    </Dialog>
  );
}
