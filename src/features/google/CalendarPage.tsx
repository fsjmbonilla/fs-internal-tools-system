import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { listCalendarEvents, type CalendarEvent } from './api';
import { isGoogleConnectionError } from './api';
import { ConnectGooglePrompt } from './ConnectGooglePrompt';
import { CreateEventDialog } from './CreateEventDialog';

/** Monday 00:00 local of the week containing `anchor`. */
function weekStart(anchor: Date): Date {
  const d = new Date(anchor);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Agenda view: the week's events grouped by day. */
export function CalendarPage() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const { fromIso, toIso, label } = useMemo(() => {
    const start = weekStart(new Date());
    start.setDate(start.getDate() + weekOffset * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return {
      fromIso: start.toISOString(),
      toIso: end.toISOString(),
      label: `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${new Date(end.getTime() - 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
    };
  }, [weekOffset]);

  const { data, error, isLoading } = useQuery({
    queryKey: ['calendar-events', fromIso, toIso],
    queryFn: () => listCalendarEvents(fromIso, toIso),
    retry: (count, err) => !isGoogleConnectionError(err) && count < 2,
  });

  if (error && isGoogleConnectionError(error)) return <ConnectGooglePrompt error={error} />;

  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of data?.events ?? []) {
    const key = fmtDay(event.start);
    byDay.set(key, [...(byDay.get(key) ?? []), event]);
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Calendar</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setWeekOffset((w) => w - 1)}>
            ←
          </Button>
          <button
            type="button"
            className="min-w-32 text-center text-sm text-muted-foreground"
            onClick={() => setWeekOffset(0)}
            title="Back to this week"
          >
            {weekOffset === 0 ? 'This week' : label}
          </button>
          <Button variant="outline" size="sm" onClick={() => setWeekOffset((w) => w + 1)}>
            →
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            New event
          </Button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && byDay.size === 0 && (
          <p className="text-sm text-muted-foreground">Nothing scheduled this week.</p>
        )}
        {[...byDay.entries()].map(([day, events]) => (
          <section key={day}>
            <h2 className="mb-1 text-sm font-medium text-muted-foreground">{day}</h2>
            <ul className="space-y-1">
              {events.map((event) => (
                <li key={event.id} className="rounded border px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{event.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {event.allDay ? 'All day' : `${fmtTime(event.start)} – ${fmtTime(event.end)}`}
                    </span>
                  </div>
                  {event.attendees.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      With {event.attendees.join(', ')}
                    </p>
                  )}
                  {event.htmlLink && (
                    <a
                      href={event.htmlLink}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary underline"
                    >
                      Open in Google Calendar
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <CreateEventDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
