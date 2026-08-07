import { useMutation, useQuery } from '@tanstack/react-query';
import { Share2, Users } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import { shareDriveFile, type DriveFile } from './api';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function typeLabel(mime: string): string {
  if (mime === 'application/vnd.google-apps.folder') return 'Folder';
  if (mime === 'application/vnd.google-apps.document') return 'Google Doc';
  if (mime === 'application/vnd.google-apps.spreadsheet') return 'Google Sheet';
  if (mime === 'application/vnd.google-apps.presentation') return 'Google Slides';
  if (mime.startsWith('image/')) return `Image (${mime.split('/')[1]})`;
  if (mime === 'application/pdf') return 'PDF';
  return mime.split('/').pop()?.slice(0, 30) ?? 'File';
}

/** GNOME-Files-style properties sidebar for the selected file. */
export function DriveDetailsPanel({
  file,
  icon,
}: {
  file: DriveFile;
  icon: React.ReactNode;
}) {
  const [shareOpen, setShareOpen] = useState(false);

  const rows: Array<readonly [string, React.ReactNode]> = [
    ['Type', typeLabel(file.mimeType)],
    ...(file.sizeBytes != null ? ([['Size', fmtSize(file.sizeBytes)]] as const) : []),
    ...(file.imageWidth && file.imageHeight
      ? ([['Dimensions', `${file.imageWidth} × ${file.imageHeight} px`]] as const)
      : []),
    ...(file.modifiedAt
      ? ([['Modified', new Date(file.modifiedAt).toLocaleString()]] as const)
      : []),
    ...(file.owner ? ([['Owner', file.owner]] as const) : []),
    [
      'Sharing',
      <span key="shared" className="flex items-center gap-1.5">
        <Users className="size-3.5" />
        {file.shared ? 'Shared' : 'Private'}
      </span>,
    ],
  ];

  return (
    <aside className="hidden w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l p-3 animate-in fade-in duration-150 md:flex">
      <div className="flex flex-col items-center gap-2 pt-2">
        {file.thumbnailLink && !file.isFolder ? (
          <img
            src={file.thumbnailLink}
            alt=""
            referrerPolicy="no-referrer"
            className="max-h-32 w-full rounded-lg border object-contain"
          />
        ) : (
          icon
        )}
        <p className="w-full break-words text-center text-sm font-medium">{file.name}</p>
      </div>
      <dl className="grid gap-2 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">{label}</dt>
            <dd className="text-right break-all">{value}</dd>
          </div>
        ))}
      </dl>
      {!file.isFolder && (
        <Button size="sm" variant="outline" onClick={() => setShareOpen(true)}>
          <Share2 className="size-4" />
          Share
        </Button>
      )}
      <ShareDialog file={file} open={shareOpen} onOpenChange={setShareOpen} />
    </aside>
  );
}

interface PublicUser {
  id: number;
  email: string;
  displayName: string;
}

/**
 * Share with a colleague. The server is the gate (registered active user on an
 * allowed domain); the registered-user datalist here is convenience, not the
 * validation.
 */
function ShareDialog({
  file,
  open,
  onOpenChange,
}: {
  file: DriveFile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'reader' | 'writer'>('reader');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: userData } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ users: PublicUser[] }>('/api/users'),
    enabled: open,
  });

  const share = useMutation({
    mutationFn: () => shareDriveFile(file.id, email.trim(), role),
    onSuccess: () => {
      setDone(`Shared with ${email.trim()}`);
      setError(null);
      setEmail('');
    },
    onError: (err) => {
      setDone(null);
      setError(err instanceof ApiError ? err.message : 'Could not share');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate">Share “{file.name}”</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            share.mutate();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="share-email">Colleague’s email</Label>
            <Input
              id="share-email"
              type="email"
              required
              list="share-registered-users"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setDone(null);
              }}
              placeholder="name@flowerstore.ph"
            />
            <datalist id="share-registered-users">
              {userData?.users.map((u) => (
                <option key={u.id} value={u.email}>
                  {u.displayName}
                </option>
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              Must be a registered user on an allowed workspace domain.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="share-role">Access</Label>
            <select
              id="share-role"
              className="h-9 rounded-lg border border-input bg-background px-2.5 text-base focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as 'reader' | 'writer')}
            >
              <option value="reader">Can view</option>
              <option value="writer">Can edit</option>
            </select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {done && <p className="text-sm text-muted-foreground animate-in fade-in">{done}</p>}
          <Button type="submit" disabled={share.isPending} className="min-h-11 md:min-h-0">
            {share.isPending ? 'Sharing…' : 'Share'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
