import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { convertNoteToDoc } from './api';

interface Project {
  id: number;
  name: string;
  isMember: boolean;
}

/**
 * Share a note by moving it into a project's documents.
 *
 * Notes are private by design, so there is no note-level sharing to grant —
 * the content moves to where sharing already exists and project membership
 * decides who sees it. Only projects the user may write to are offered, since
 * creating a doc requires membership.
 */
export function MoveToProjectDialog({ noteId, noteTitle }: { noteId: number; noteTitle: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ projects: Project[] }>('/api/projects'),
    enabled: open,
  });
  const writable = (data?.projects ?? []).filter((p) => p.isMember);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { doc } = await convertNoteToDoc(noteId, Number(projectId));
      setOpen(false);
      navigate(`/projects/${doc.projectId}/docs/${doc.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move the note');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Share…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share “{noteTitle}” with a project</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Notes are private to you. Sharing moves this one into a project as a document, where
            everyone in that project can read and edit it — and it leaves your notes.
          </p>
          {writable.length === 0 ? (
            <p className="text-sm">
              You are not a member of any project yet. Join or create one first — a document can
              only be added by a project member.
            </p>
          ) : (
            <>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger aria-label="Project">
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectContent>
                  {writable.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
              <Button disabled={!projectId || busy} onClick={submit}>
                {busy ? 'Moving…' : 'Move to project docs'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
