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
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="mr-auto text-base font-semibold">Sheets</h1>
        <Input
          className="w-56"
          placeholder="New sheet name"
          value={title}
          aria-label="New sheet name"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create.mutate()}
        />
        <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Creating…' : 'New sheet'}
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data?.sheets.length === 0 && (
        <p className="text-sm text-muted-foreground">No sheets in this project yet.</p>
      )}

      <ul className="grid gap-1">
        {data?.sheets.map((s) => (
          <li key={s.id} className="flex items-center gap-2 rounded border p-2">
            <Link to={`/sheets/${s.id}`} className="mr-auto text-sm font-medium hover:underline">
              {s.title}
            </Link>
            <span className="text-xs text-muted-foreground">
              edited {new Date(s.updatedAt).toLocaleString()}
            </span>
            <Button variant="destructive" size="sm" onClick={() => remove.mutate(s.id)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
