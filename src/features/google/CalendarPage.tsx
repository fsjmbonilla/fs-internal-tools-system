import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { listCalendarEvents, type CalendarEvent } from './api';
import { isGoogleConnectionError } from './api';
import { ConnectGooglePrompt } from './ConnectGooglePrompt';
import { CreateEventDialog, type EventPrefill } from './CreateEventDialog';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Local y-m-d key — events group by the local date they start on. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** GNOME-Calendar-style month view: a full-height grid plus a day panel. */
export function CalendarPage() {
  const [monthOffset, setMonthOffset] = useState(0);
  const [selected, setSelected] = useState(startOfToday);
  const [createOpen, setCreateOpen] = useState(false);
  const [prefillDay, setPrefillDay] = useState<Date | null>(null);

  // Grid: Monday-start weeks covering the whole month, leading/trailing days
  // included. All date math is local; the ISO range converts once at the edge.
  const { days, weekCount, monthIndex, label, fromIso, toIso } = useMemo(() => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const weeks = Math.ceil((lead + daysInMonth) / 7);
    const cells = Array.from({ length: weeks * 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
    const end = new Date(start);
    end.setDate(start.getDate() + weeks * 7);
    return {
      days: cells,
      weekCount: weeks,
      monthIndex: first.getMonth(),
      label: first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      fromIso: start.toISOString(),
      toIso: end.toISOString(),
    };
  }, [monthOffset]);

  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['calendar-events', fromIso, toIso],
    queryFn: () => listCalendarEvents(fromIso, toIso),
    retry: (count, err) => !isGoogleConnectionError(err) && count < 2,
  });

  const prefill = useMemo<EventPrefill | undefined>(() => {
    if (!prefillDay) return undefined;
    const pad = (n: number) => String(n).padStart(2, '0');
    const base = `${prefillDay.getFullYear()}-${pad(prefillDay.getMonth() + 1)}-${pad(prefillDay.getDate())}`;
    return { start: `${base}T09:00`, end: `${base}T10:00` };
  }, [prefillDay]);

  if (error && isGoogleConnectionError(error)) return <ConnectGooglePrompt error={error} />;

  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of data?.events ?? []) {
    const key = dayKey(new Date(event.start));
    byDay.set(key, [...(byDay.get(key) ?? []), event]);
  }
  for (const events of byDay.values()) {
    events.sort((a, b) => a.start.localeCompare(b.start));
  }

  const todayKey = dayKey(new Date());
  const selectedKey = dayKey(selected);
  const selectedEvents = byDay.get(selectedKey) ?? [];

  const openCreate = (day: Date | null) => {
    setPrefillDay(day);
    setCreateOpen(true);
  };

  return (
    <div className="flex h-full w-full flex-col gap-2 p-2 md:p-3">
      <div className="flex items-center justify-between gap-1">
        <h1 className="text-lg font-semibold">{label}</h1>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
            aria-label="Previous month"
            onClick={() => setMonthOffset((o) => o - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-0"
            onClick={() => {
              setMonthOffset(0);
              setSelected(startOfToday());
            }}
          >
            Today
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
            aria-label="Next month"
            onClick={() => setMonthOffset((o) => o + 1)}
          >
            <ChevronRight />
          </Button>
          <Button size="sm" className="min-h-11 md:min-h-0" onClick={() => openCreate(null)}>
            <Plus />
            <span className="max-sm:sr-only">New event</span>
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/50 px-2 py-1 text-sm text-destructive">
          <span>Couldn’t load this month’s events.</span>
          <Button variant="outline" size="sm" className="min-h-11 md:min-h-0" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 md:flex-row">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
          <div className="grid shrink-0 grid-cols-7 gap-px border-b bg-border text-center text-xs font-medium text-muted-foreground">
            {WEEKDAYS.map((d) => (
              <div key={d} className="bg-background py-1">
                {d}
              </div>
            ))}
          </div>
          {isLoading ? (
            <MonthSkeleton weekCount={weekCount} />
          ) : (
            <div
              className="grid min-h-0 flex-1 grid-cols-7 gap-px bg-border"
              style={{ gridTemplateRows: `repeat(${weekCount}, minmax(0, 1fr))` }}
            >
              {days.map((day) => {
                const key = dayKey(day);
                const events = byDay.get(key) ?? [];
                const isToday = key === todayKey;
                const isSelected = key === selectedKey;
                const outside = day.getMonth() !== monthIndex;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelected(day)}
                    aria-label={day.toLocaleDateString(undefined, {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                    })}
                    aria-current={isToday ? 'date' : undefined}
                    className={`flex min-h-0 flex-col items-stretch gap-0.5 overflow-hidden p-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:p-1 ${
                      isSelected ? 'bg-accent' : 'bg-background hover:bg-accent'
                    }`}
                  >
                    <span
                      className={`flex size-6 shrink-0 items-center justify-center self-start rounded-full text-xs ${
                        isToday
                          ? 'bg-primary font-semibold text-primary-foreground'
                          : outside
                            ? 'text-muted-foreground/60'
                            : isSelected
                              ? 'font-semibold'
                              : ''
                      }`}
                    >
                      {day.getDate()}
                    </span>
                    {events.length > 0 && (
                      <div className="flex gap-0.5 pl-1.5 md:hidden" aria-hidden="true">
                        {events.slice(0, 2).map((event) => (
                          <span key={event.id} className="size-1.5 rounded-full bg-primary" />
                        ))}
                        {events.length > 2 && (
                          <span className="text-[10px] leading-none text-muted-foreground">
                            +{events.length - 2}
                          </span>
                        )}
                      </div>
                    )}
                    <div className={`hidden min-h-0 flex-col gap-0.5 overflow-hidden md:flex ${outside ? 'opacity-60' : ''}`}>
                      {events.slice(0, 3).map((event) => (
                        <span
                          key={event.id}
                          className="truncate rounded bg-primary/15 px-1 text-[11px] leading-4 text-primary"
                          title={event.title}
                        >
                          {!event.allDay && (
                            <span className="font-medium">{fmtTime(event.start)} </span>
                          )}
                          {event.title}
                        </span>
                      ))}
                      {events.length > 3 && (
                        <span className="px-1 text-[11px] leading-4 text-muted-foreground">
                          +{events.length - 3} more
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <section
          aria-label="Selected day"
          className="flex h-40 shrink-0 flex-col overflow-hidden rounded-lg border md:h-auto md:w-72 lg:w-80"
        >
          <h2 className="shrink-0 border-b px-2 py-1.5 text-sm font-medium">
            {selected.toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
            })}
          </h2>
          <div
            key={selectedKey}
            className="min-h-0 flex-1 overflow-y-auto p-2 animate-in fade-in duration-150"
          >
            {isLoading ? (
              <div className="animate-pulse space-y-1">
                <div className="h-14 rounded border bg-muted/50" />
                <div className="h-14 rounded border bg-muted/50" />
              </div>
            ) : selectedEvents.length === 0 ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-muted-foreground">Nothing scheduled this day.</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 md:min-h-0"
                  onClick={() => openCreate(selected)}
                >
                  New event
                </Button>
              </div>
            ) : (
              <ul className="space-y-1">
                {selectedEvents.map((event) => (
                  <li key={event.id} className="rounded border px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{event.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {event.allDay
                          ? 'All day'
                          : `${fmtTime(event.start)} – ${fmtTime(event.end)}`}
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
                        className="inline-flex min-h-11 items-center text-xs text-primary underline md:min-h-0"
                      >
                        Open in Google Calendar
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      <CreateEventDialog open={createOpen} onOpenChange={setCreateOpen} prefill={prefill} />
    </div>
  );
}

/** Skeleton shaped like the month grid (pulsing cells) while events load. */
function MonthSkeleton({ weekCount }: { weekCount: number }) {
  return (
    <div
      className="grid min-h-0 flex-1 animate-pulse grid-cols-7 gap-px bg-border"
      style={{ gridTemplateRows: `repeat(${weekCount}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: weekCount * 7 }, (_, i) => (
        <div key={i} className="bg-muted/50" />
      ))}
    </div>
  );
}
