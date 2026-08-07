import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createSheet, deleteSheet, listSheets } from './api';

/** The spreadsheets in one project. Sheets live beside docs, under the same rules. */
export function SheetListPage() {
  const { projectId: raw } = useParams();
  const projectId = Number(raw);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['sheets', projectId],
    queryFn: () => listSheets(projectId),
    enabled: Number.isInteger(projectId) && projectId > 0,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['sheets', projectId] });

  const create = useMutation({
    mutationFn: () => createSheet(projectId, title.trim() || 'Untitled sheet'),
    onSuccess: (res) => {
      setTitle('');
      invalidate();
      // Straight into the new sheet — creating one and landing back on a list is
      // never what anyone wanted.
      void navigate(`/sheets/${res.sheet.id}`);
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => deleteSheet(id),
    onSuccess: invalidate,
  });

  return (
    <div className="h-full overflow-y-auto p-4 animate-in fade-in">
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center">
        <h1 className="text-base font-semibold md:mr-auto">Sheets</h1>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!create.isPending) create.mutate();
          }}
        >
          <Input
            className="flex-1 md:w-56 md:flex-none"
            placeholder="New sheet name"
            value={title}
            aria-label="New sheet name"
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button type="submit" size="sm" className="min-h-11 md:min-h-7" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'New sheet'}
          </Button>
        </form>
      </div>

      {isLoading && (
        <div className="space-y-1" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      )}
      {!isLoading && data?.sheets.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No sheets in this project yet — name one above to create the first.
        </p>
      )}

      <ul className="grid gap-1">
        {data?.sheets.map((s) => (
          <li
            key={s.id}
            className="flex min-h-11 items-center gap-2 rounded-md border p-2 transition-colors hover:bg-accent"
          >
            <Link to={`/sheets/${s.id}`} className="mr-auto min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{s.title}</span>
              <span className="block text-xs text-muted-foreground">
                edited {new Date(s.updatedAt).toLocaleString()}
              </span>
            </Link>
            <Button
              variant="destructive"
              size="sm"
              className="min-h-11 md:min-h-7"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete “${s.title}”?`)) remove.mutate(s.id);
              }}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
