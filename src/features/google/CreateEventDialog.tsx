import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { createCalendarEvent, type CalendarEvent } from './api';

export interface EventPrefill {
  title?: string;
  start?: string; // datetime-local format
  end?: string;
  description?: string;
  location?: string;
}

/** Local-time input value for `at`, rounded up to the next half hour. */
function nextSlot(offsetMinutes = 0): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() + offsetMinutes);
  d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * One dialog for every "put this on my calendar" entry point: the /calendar
 * page, a channel header's Schedule meeting, a task's Add to calendar. The
 * entry points differ only in prefill.
 */
export function CreateEventDialog({
  open,
  onOpenChange,
  prefill,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: EventPrefill;
  onCreated?: (event: CalendarEvent) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [attendees, setAttendees] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form each time the dialog opens — a dialog reused across entry
  // points must not leak one prefill into the next.
  useEffect(() => {
    if (!open) return;
    setTitle(prefill?.title ?? '');
    setStart(prefill?.start ?? nextSlot());
    setEnd(prefill?.end ?? nextSlot(60));
    setAttendees('');
    setDescription(prefill?.description ?? '');
    setError(null);
  }, [open, prefill]);

  const create = useMutation({
    mutationFn: () =>
      createCalendarEvent({
        title,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        attendees: attendees
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
        description: description || undefined,
        location: prefill?.location,
      }),
    onSuccess: ({ event }) => {
      void queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      onOpenChange(false);
      onCreated?.(event);
    },
    onError: (err) => {
      setError(
        err instanceof ApiError && err.code.startsWith('google_')
          ? 'Google is not connected — connect it in Settings first.'
          : err instanceof Error
            ? err.message
            : 'Could not create the event',
      );
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New calendar event</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="evt-title">Title</Label>
            <Input
              id="evt-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={300}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="evt-start">Starts</Label>
              <Input
                id="evt-start"
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="evt-end">Ends</Label>
              <Input
                id="evt-end"
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="evt-attendees">Attendees (comma-separated emails, optional)</Label>
            <Input
              id="evt-attendees"
              value={attendees}
              onChange={(e) => setAttendees(e.target.value)}
              placeholder="ana@flowerstore.ph, ben@flowerstore.ph"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="evt-desc">Description (optional)</Label>
            <Textarea
              id="evt-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={create.isPending || !title}>
            {create.isPending ? 'Creating…' : 'Create event'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
