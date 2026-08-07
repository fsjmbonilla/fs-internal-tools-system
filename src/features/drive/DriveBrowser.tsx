import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  LayoutGrid,
  List,
  Loader2,
  Presentation,
  UploadCloud,
} from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { isGoogleConnectionError } from '@/features/google/api';
import { ConnectGooglePrompt } from '@/features/google/ConnectGooglePrompt';
import { moveDriveFile, type DriveFile, type DriveListResult } from './api';
import { DriveDetailsPanel } from './DriveDetailsPanel';
import { DriveFilePreviewDialog } from './DriveFilePreviewDialog';
import { canPreviewDriveFile } from './preview';

interface Crumb {
  id: string | undefined;
  name: string;
}

/** dataTransfer type marking an internal move-drag, distinct from OS file drops. */
const MOVE_TYPE = 'application/x-fsdrive-file';

/** Thumbnail when Drive has one (images mostly), else the mime icon. */
function FileVisual({ file, className }: { file: DriveFile; className: string }) {
  if (!file.isFolder && file.thumbnailLink) {
    return (
      <img
        src={file.thumbnailLink}
        alt=""
        loading="lazy"
        draggable={false}
        referrerPolicy="no-referrer"
        className={`${className} rounded border object-cover`}
      />
    );
  }
  return <FileIcon file={file} className={className} />;
}

/** GNOME-Files-style icon per mime family; folders get the filled folder. */
function FileIcon({ file, className }: { file: DriveFile; className: string }) {
  if (file.isFolder) {
    return <Folder className={`${className} fill-primary/20 text-primary`} />;
  }
  const mime = file.mimeType;
  const Icon = mime.startsWith('image/')
    ? FileImage
    : mime.startsWith('video/')
      ? FileVideo
      : mime.startsWith('audio/')
        ? FileAudio
        : /pdf|document|text/.test(mime)
          ? FileText
          : /spreadsheet|csv|excel/.test(mime)
            ? FileSpreadsheet
            : /presentation|powerpoint/.test(mime)
              ? Presentation
              : /zip|compressed|tar/.test(mime)
                ? FileArchive
                : File;
  return <Icon className={`${className} text-muted-foreground`} />;
}

/**
 * One Drive browser for every surface that needs one — My Drive, a project's
 * Files tab, the attach-from-Drive picker. GNOME-Files-style: a pill path bar,
 * an icon grid (or list) where the first click/tap selects and the second
 * opens, and either "open in Google" (default) or `onPickFile` (picker mode)
 * as the open action for files.
 */
export function DriveBrowser({
  rootName,
  fetchPage,
  searchable = false,
  onPickFile,
  onNavigate,
  onDropFiles,
}: {
  rootName: string;
  /** Load one page. `folderId` undefined means the root this browser starts at. */
  fetchPage: (opts: { folderId?: string; q?: string }) => Promise<DriveListResult>;
  searchable?: boolean;
  onPickFile?: (file: DriveFile) => void;
  /** Fires when a folder is entered — the folder picker selects by navigation. */
  onNavigate?: (folder: DriveFile) => void;
  /** Enables drag-and-drop upload into the folder being viewed. */
  onDropFiles?: (files: File[], currentFolderId: string | undefined) => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: undefined, name: rootName }]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<DriveFile | null>(null);
  const [view, setView] = useState<'grid' | 'list'>(
    () => (localStorage.getItem('drive-view') === 'list' ? 'list' : 'grid'),
  );
  const current = crumbs[crumbs.length - 1];

  const { data, error, isLoading } = useQuery({
    queryKey: ['drive-browse', rootName, current.id ?? 'root', query ?? ''],
    queryFn: () => fetchPage({ folderId: current.id, q: query }),
    retry: (count, err) => !isGoogleConnectionError(err) && count < 2,
  });

  if (error && isGoogleConnectionError(error)) return <ConnectGooglePrompt error={error} />;

  function open(file: DriveFile) {
    setSelectedId(null);
    if (file.isFolder) {
      setQuery(undefined);
      setSearch('');
      setCrumbs((prev) => [...prev, { id: file.id, name: file.name }]);
      onNavigate?.(file);
      return;
    }
    if (onPickFile) onPickFile(file);
    // Docs/Sheets/office files render inside the app; Google is the fallback,
    // not the default.
    else if (canPreviewDriveFile(file)) setPreviewFile(file);
    else if (file.webViewLink) window.open(file.webViewLink, '_blank', 'noreferrer');
  }

  /** GNOME activation: first click selects, a click on the selection opens. */
  function activate(file: DriveFile) {
    if (selectedId === file.id) open(file);
    else setSelectedId(file.id);
  }

  function switchView(next: 'grid' | 'list') {
    setView(next);
    localStorage.setItem('drive-view', next);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    // An internal file drag reaching the background is a no-op (same folder).
    if (e.dataTransfer.getData(MOVE_TYPE)) return;
    if (!onDropFiles) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      await onDropFiles(files, current.id);
      await queryClient.invalidateQueries({ queryKey: ['drive-browse'] });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  /** Dropping a dragged file onto a folder item (or a breadcrumb) moves it. */
  async function handleMoveDrop(e: React.DragEvent, toFolderId: string) {
    const fileId = e.dataTransfer.getData(MOVE_TYPE);
    if (!fileId || fileId === toFolderId) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    setUploadError(null);
    try {
      await moveDriveFile(fileId, toFolderId);
      setSelectedId(null);
      await queryClient.invalidateQueries({ queryKey: ['drive-browse'] });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not move that file');
    }
  }

  const dragProps = (file: DriveFile) =>
    file.isFolder
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (e.dataTransfer.types.includes(MOVE_TYPE)) e.preventDefault();
          },
          onDrop: (e: React.DragEvent) => void handleMoveDrop(e, file.id),
        }
      : {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData(MOVE_TYPE, file.id);
            e.dataTransfer.effectAllowed = 'move';
          },
        };

  const selectedFile = data?.files.find((f) => f.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Path bar: connected pill buttons, like Nautilus. */}
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-lg border bg-muted/40 p-1 text-sm">
          {crumbs.map((crumb, i) => (
            <span key={`${crumb.id ?? 'root'}-${i}`} className="flex shrink-0 items-center">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
              <button
                type="button"
                className={`min-h-9 rounded-md px-2.5 transition-colors md:min-h-7 ${
                  i === crumbs.length - 1
                    ? 'bg-background font-medium shadow-sm'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
                onClick={() => {
                  setSelectedId(null);
                  setCrumbs((prev) => prev.slice(0, i + 1));
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(MOVE_TYPE)) e.preventDefault();
                }}
                onDrop={(e) => void handleMoveDrop(e, crumb.id ?? 'root')}
              >
                {i === 0 ? (
                  <span className="flex items-center gap-1.5">
                    <Folder className="size-4" />
                    {crumb.name}
                  </span>
                ) : (
                  crumb.name
                )}
              </button>
            </span>
          ))}
          {query && (
            <span className="shrink-0 px-2 text-muted-foreground">results for “{query}”</span>
          )}
        </nav>
        <div className="flex items-center gap-2">
          {searchable && (
            <form
              className="flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                setQuery(search || undefined);
              }}
            >
              <Input
                className="w-full sm:w-48"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search Drive…"
              />
            </form>
          )}
          <div className="flex shrink-0 rounded-lg border p-0.5">
            <button
              type="button"
              aria-label="Grid view"
              aria-pressed={view === 'grid'}
              onClick={() => switchView('grid')}
              className={`flex min-h-9 min-w-9 items-center justify-center rounded-md transition-colors md:min-h-7 md:min-w-7 ${
                view === 'grid' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <LayoutGrid className="size-4" />
            </button>
            <button
              type="button"
              aria-label="List view"
              aria-pressed={view === 'list'}
              onClick={() => switchView('list')}
              className={`flex min-h-9 min-w-9 items-center justify-center rounded-md transition-colors md:min-h-7 md:min-w-7 ${
                view === 'list' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <List className="size-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 rounded-lg border">
      <div
        className={`relative min-h-0 min-w-0 flex-1 overflow-y-auto ${
          dragOver ? 'bg-primary/5 ring-2 ring-inset ring-primary/40' : ''
        }`}
        onDragOver={
          onDropFiles
            ? (e) => {
                e.preventDefault();
                setDragOver(true);
              }
            : undefined
        }
        onDragLeave={onDropFiles ? () => setDragOver(false) : undefined}
        onDrop={onDropFiles ? handleDrop : undefined}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-lg border bg-background/95 px-4 py-2 text-sm shadow-sm">
              <UploadCloud className="size-4 text-primary" />
              Drop to upload into “{current.name}”
            </div>
          </div>
        )}
        {uploading && (
          <div className="flex items-center gap-2 border-b px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Uploading…
          </div>
        )}
        {uploadError && (
          <p className="border-b px-3 py-2 text-sm text-destructive">{uploadError}</p>
        )}
        {isLoading && (view === 'grid' ? <FileGridSkeleton /> : <FileListSkeleton />)}
        {!isLoading && (data?.files.length ?? 0) === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            {query ? 'Nothing matches that search.' : 'This folder is empty.'}
          </p>
        )}
        {!isLoading && view === 'grid' && (data?.files.length ?? 0) > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-1 p-2 animate-in fade-in duration-150">
            {data?.files.map((file) => (
              <button
                key={file.id}
                type="button"
                title={file.name}
                onClick={() => activate(file)}
                {...dragProps(file)}
                className={`flex flex-col items-center gap-1.5 rounded-lg p-2.5 text-center transition-colors ${
                  selectedId === file.id ? 'bg-accent' : 'hover:bg-accent/50'
                }`}
              >
                <FileVisual file={file} className="size-12" />
                <span className="line-clamp-2 w-full text-xs break-words">{file.name}</span>
              </button>
            ))}
          </div>
        )}
        {!isLoading && view === 'list' && (
          <div className="animate-in fade-in duration-150">
            {data?.files.map((file) => (
              <button
                key={file.id}
                type="button"
                onClick={() => activate(file)}
                {...dragProps(file)}
                className={`flex min-h-11 w-full items-center gap-2.5 border-b px-3 py-2 text-left text-sm transition-colors last:border-b-0 md:min-h-0 ${
                  selectedId === file.id ? 'bg-accent' : 'hover:bg-accent/50'
                }`}
              >
                <FileVisual file={file} className="size-5" />
                <span className="flex-1 truncate">{file.name}</span>
                {file.owner && (
                  <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                    {file.owner}
                  </span>
                )}
                {file.modifiedAt && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {new Date(file.modifiedAt).toLocaleDateString()}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      {selectedFile && (
        <DriveDetailsPanel
          file={selectedFile}
          icon={<FileIcon file={selectedFile} className="size-16" />}
        />
      )}
      </div>
      <DriveFilePreviewDialog
        file={previewFile}
        onOpenChange={(open) => {
          if (!open) setPreviewFile(null);
        }}
      />
    </div>
  );
}

/** Skeleton shaped like the icon grid while a folder loads. */
function FileGridSkeleton() {
  return (
    <div className="grid animate-pulse grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-1 p-2">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex flex-col items-center gap-1.5 p-2.5">
          <div className="size-12 rounded-lg bg-muted" />
          <div className="h-3 w-16 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton shaped like the file rows while a folder loads. */
function FileListSkeleton() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-2 border-b px-3 py-3 last:border-b-0">
          <div className="size-5 shrink-0 rounded bg-muted" />
          <div className="h-3.5 flex-1 rounded bg-muted" />
          <div className="h-3 w-16 shrink-0 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
