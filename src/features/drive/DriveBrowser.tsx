import { useQuery } from '@tanstack/react-query';
import { Folder } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { isGoogleConnectionError } from '@/features/google/api';
import { ConnectGooglePrompt } from '@/features/google/ConnectGooglePrompt';
import type { DriveFile, DriveListResult } from './api';

interface Crumb {
  id: string | undefined;
  name: string;
}

/**
 * One Drive browser for every surface that needs one — My Drive, a project's
 * Files tab, the attach-from-Drive picker. Folder navigation with breadcrumbs,
 * optional search, and either "open in Google" (default) or `onPickFile`
 * (picker mode) on click.
 */
export function DriveBrowser({
  rootName,
  fetchPage,
  searchable = false,
  onPickFile,
  onNavigate,
}: {
  rootName: string;
  /** Load one page. `folderId` undefined means the root this browser starts at. */
  fetchPage: (opts: { folderId?: string; q?: string }) => Promise<DriveListResult>;
  searchable?: boolean;
  onPickFile?: (file: DriveFile) => void;
  /** Fires when a folder is entered — the folder picker selects by navigation. */
  onNavigate?: (folder: DriveFile) => void;
}) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: undefined, name: rootName }]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState<string | undefined>(undefined);
  const current = crumbs[crumbs.length - 1];

  const { data, error, isLoading } = useQuery({
    queryKey: ['drive-browse', rootName, current.id ?? 'root', query ?? ''],
    queryFn: () => fetchPage({ folderId: current.id, q: query }),
    retry: (count, err) => !isGoogleConnectionError(err) && count < 2,
  });

  if (error && isGoogleConnectionError(error)) return <ConnectGooglePrompt error={error} />;

  function open(file: DriveFile) {
    if (file.isFolder) {
      setQuery(undefined);
      setSearch('');
      setCrumbs((prev) => [...prev, { id: file.id, name: file.name }]);
      onNavigate?.(file);
      return;
    }
    if (onPickFile) onPickFile(file);
    else if (file.webViewLink) window.open(file.webViewLink, '_blank', 'noreferrer');
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <nav className="flex flex-1 flex-wrap items-center gap-1 text-sm">
          {crumbs.map((crumb, i) => (
            <span key={`${crumb.id ?? 'root'}-${i}`} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground">/</span>}
              <button
                type="button"
                className={i === crumbs.length - 1 ? 'font-medium' : 'text-primary underline'}
                onClick={() => setCrumbs((prev) => prev.slice(0, i + 1))}
              >
                {crumb.name}
              </button>
            </span>
          ))}
          {query && <span className="text-muted-foreground">· results for “{query}”</span>}
        </nav>
        {searchable && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(search || undefined);
            }}
          >
            <Input
              className="w-48"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search Drive…"
            />
          </form>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded border">
        {isLoading && <p className="p-3 text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && (data?.files.length ?? 0) === 0 && (
          <p className="p-3 text-sm text-muted-foreground">
            {query ? 'Nothing matches that search.' : 'This folder is empty.'}
          </p>
        )}
        {data?.files.map((file) => (
          <button
            key={file.id}
            type="button"
            onClick={() => open(file)}
            className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
          >
            {file.isFolder ? (
              <Folder className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <span className="w-4 shrink-0" />
            )}
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
    </div>
  );
}
