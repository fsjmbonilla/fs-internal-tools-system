import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { useProjectMembership } from '@/features/projects/useProjectMembership';
import { ApiError } from '@/lib/api';
import {
  getProjectDriveFolder,
  bindProjectDriveFolder,
  listDriveFiles,
  listProjectDriveFiles,
  unbindProjectDriveFolder,
  type DriveFile,
} from './api';
import { DriveBrowser } from './DriveBrowser';

/**
 * A project's Files tab: the bound Drive folder browsed in-app. Drive stays
 * the source of truth for heavyweight files; our native sheets and docs remain
 * the collaborative layer. Binding is a lead's act; browsing and uploading use
 * each viewer's own Google connection.
 */
export function ProjectFilesPage() {
  const { projectId } = useParams();
  const id = Number(projectId);
  const queryClient = useQueryClient();
  const { canEdit } = useProjectMembership(id);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: binding } = useQuery({
    queryKey: ['project-drive-folder', id],
    queryFn: () => getProjectDriveFolder(id),
    enabled: Number.isFinite(id),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['project-drive-folder', id] });
    void queryClient.invalidateQueries({ queryKey: ['drive-browse'] });
  };

  const bind = useMutation({
    mutationFn: (folderId: string) => bindProjectDriveFolder(id, folderId),
    onSuccess: () => {
      setPicking(false);
      setNotice(null);
      invalidate();
    },
    onError: (err) =>
      setNotice(err instanceof ApiError ? err.message : 'Could not bind that folder'),
  });
  const unbind = useMutation({ mutationFn: () => unbindProjectDriveFolder(id), onSuccess: invalidate });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      // Multipart, so this one bypasses the JSON api() helper.
      const form = new FormData();
      form.append('file', file);
      const { useAuthStore } = await import('@/features/auth/authStore');
      const token = useAuthStore.getState().accessToken;
      const base = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4000';
      const res = await fetch(`${base}/api/projects/${id}/drive-files`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error?.message ?? 'Upload failed');
      }
    },
    onSuccess: () => {
      setNotice(null);
      invalidate();
    },
    onError: (err) => setNotice(err instanceof Error ? err.message : 'Upload failed'),
  });

  if (!Number.isFinite(id)) return null;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Project files</h1>
        {binding?.folder && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={upload.isPending}
            >
              {upload.isPending ? 'Uploading…' : 'Upload to Drive'}
            </Button>
            {canEdit && (
              <Button size="sm" variant="outline" onClick={() => unbind.mutate()}>
                Unbind folder
              </Button>
            )}
          </div>
        )}
      </div>
      {notice && <p className="mb-2 text-sm text-red-600">{notice}</p>}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) upload.mutate(file);
        }}
      />

      {!binding?.folder && !picking && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">
            No Drive folder is bound to this project yet.
          </p>
          {canEdit ? (
            <Button onClick={() => setPicking(true)}>Bind a Drive folder</Button>
          ) : (
            <p className="text-xs text-muted-foreground">A project lead can bind one.</p>
          )}
        </div>
      )}

      {!binding?.folder && picking && (
        <>
          <p className="mb-2 text-sm text-muted-foreground">
            Pick the folder from your Drive (folders only — click one to enter it, then bind
            it here):
          </p>
          <PickFolder onPick={(f) => bind.mutate(f.id)} onCancel={() => setPicking(false)} />
        </>
      )}

      {binding?.folder && (
        <DriveBrowser
          rootName={binding.folder.folderName}
          fetchPage={(opts) => listProjectDriveFiles(id, opts)}
        />
      )}
    </div>
  );
}

/** Folder picker: browse own Drive, bind the folder currently open. */
function PickFolder({
  onPick,
  onCancel,
}: {
  onPick: (folder: DriveFile) => void;
  onCancel: () => void;
}) {
  const [currentFolder, setCurrentFolder] = useState<DriveFile | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <DriveBrowser
        rootName="My Drive"
        fetchPage={async (opts) => {
          const result = await listDriveFiles(opts);
          return { ...result, files: result.files.filter((f) => f.isFolder) };
        }}
        onNavigate={setCurrentFolder}
      />
      <div className="flex items-center justify-end gap-2">
        {currentFolder && (
          <span className="mr-auto text-sm">
            Selected: <span className="font-medium">{currentFolder.name}</span>
          </span>
        )}
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!currentFolder} onClick={() => currentFolder && onPick(currentFolder)}>
          Bind this folder
        </Button>
      </div>
    </div>
  );
}
