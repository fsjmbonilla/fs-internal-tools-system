import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CalendarDays,
  File as FileIcon,
  FolderKanban,
  LifeBuoy,
  MessageSquare,
  Share2,
  Sparkles,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/features/auth/authStore';
import { ApiError } from '@/lib/api';
import { getToday, summarizeDay, type NewProjectEntry, type NewTicketEntry } from './api';

function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function eventTime(start: string, allDay: boolean): string {
  if (allDay) return 'All day';
  return new Date(start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const { data, isError, refetch } = useQuery({ queryKey: ['dashboard', 'today'], queryFn: getToday });

  const now = new Date();
  const today = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const unreadRows = data
    ? [
        ...data.unread.channels.map((c) => ({
          key: `c${c.id}`,
          to: `/chat/${c.id}`,
          label: `# ${c.name}`,
          count: c.unreadCount,
        })),
        ...data.unread.dms.map((d) => ({
          key: `d${d.id}`,
          to: `/chat/${d.id}`,
          label: d.displayName,
          count: d.unreadCount,
        })),
      ]
    : [];

  return (
    <main className="h-full w-full overflow-y-auto p-4 animate-in fade-in duration-150 md:p-6">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          {greetingFor(now.getHours())}, {user?.displayName ?? 'there'}
        </h1>
        <p className="text-sm text-muted-foreground">{today}</p>
      </header>

      <SummaryCard />

      {isError && (
        <div className="mt-4 rounded-xl border p-4 text-sm text-destructive">
          Your day could not be loaded.{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => refetch()}>
            Retry
          </button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Widget
          title="Today's events"
          icon={CalendarDays}
          loading={!data}
          notConnected={data?.events === null}
          isEmpty={data?.events?.length === 0}
          empty="Nothing on your calendar today."
        >
          {data?.events?.map((e) => (
            <Link key={e.id} to="/calendar" className={rowClass}>
              <span className="w-16 shrink-0 text-xs tabular-nums text-muted-foreground">
                {eventTime(e.start, e.allDay)}
              </span>
              <span className="truncate">{e.title}</span>
            </Link>
          ))}
        </Widget>

        <Widget
          title="Unread"
          icon={MessageSquare}
          loading={!data}
          isEmpty={unreadRows.length === 0}
          empty="All caught up — nothing unread."
        >
          {unreadRows.map((r) => (
            <Link key={r.key} to={r.to} className={rowClass}>
              <span className="truncate font-medium">{r.label}</span>
              <span className="ml-auto shrink-0 rounded-full bg-destructive px-1.5 text-xs font-semibold text-white">
                {r.count}
              </span>
            </Link>
          ))}
        </Widget>

        <Widget
          title="Shared with me"
          icon={Share2}
          loading={!data}
          notConnected={data?.sharedFiles === null}
          isEmpty={data?.sharedFiles?.length === 0}
          empty="Nothing has been shared with you recently."
        >
          {data?.sharedFiles?.map((f) => {
            const inner = (
              <>
                {f.thumbnailLink ? (
                  <img
                    src={f.thumbnailLink}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="size-8 shrink-0 rounded border object-cover"
                  />
                ) : (
                  <span className="flex size-8 shrink-0 items-center justify-center rounded bg-muted">
                    <FileIcon className="size-4 text-muted-foreground" />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate">{f.name}</span>
                  {f.owner && (
                    <span className="block truncate text-xs text-muted-foreground">{f.owner}</span>
                  )}
                </span>
              </>
            );
            return f.webViewLink ? (
              <a key={f.id} href={f.webViewLink} target="_blank" rel="noreferrer" className={rowClass}>
                {inner}
              </a>
            ) : (
              <div key={f.id} className={rowClass}>
                {inner}
              </div>
            );
          })}
        </Widget>

        <Widget
          title="New tickets"
          icon={LifeBuoy}
          loading={!data}
          isEmpty={data?.newTickets.length === 0}
          empty="No support tickets filed today."
        >
          {data?.newTickets.map((t: NewTicketEntry) => (
            <Link key={t.id} to={`/projects/${t.projectId}`} className={rowClass}>
              <span className="min-w-0">
                <span className="block truncate">{t.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {t.projectName}
                  {t.columnName ? ` · ${t.columnName}` : ''}
                </span>
              </span>
            </Link>
          ))}
        </Widget>

        <Widget
          title="New projects"
          icon={FolderKanban}
          loading={!data}
          isEmpty={data?.newProjects.length === 0}
          empty="No projects created this week."
        >
          {data?.newProjects.map((p: NewProjectEntry) => (
            <Link key={p.id} to={`/projects/${p.id}`} className={rowClass}>
              <span className="truncate">{p.name}</span>
            </Link>
          ))}
        </Widget>
      </div>
    </main>
  );
}

/**
 * The AI day summary. Fetched only on demand — it is a paid call, so nothing
 * fires on page load. An unconfigured server is a quiet, muted line, not an
 * error: the widgets are the dashboard, the summary is a garnish.
 */
function SummaryCard() {
  const mutation = useMutation({ mutationFn: summarizeDay });
  const err = mutation.error;
  const notConfigured = err instanceof ApiError && err.code === 'ai_unconfigured';

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground animate-in fade-in duration-150">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-muted-foreground" />
          Day summary
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Summarizing…' : 'Summarize my day'}
        </Button>
      </div>
      {mutation.data && (
        <p className="mt-3 text-sm leading-relaxed animate-in fade-in duration-150">
          {mutation.data.summary}
        </p>
      )}
      {notConfigured && (
        <p className="mt-3 text-sm text-muted-foreground">
          AI summaries aren't configured on this server.
        </p>
      )}
      {err && !notConfigured && (
        <p className="mt-3 text-sm text-destructive">
          The summary failed — try again in a minute.
        </p>
      )}
    </section>
  );
}

const rowClass =
  'flex min-h-11 items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-accent md:min-h-8';

function Widget({
  title,
  icon: Icon,
  loading,
  notConnected = false,
  isEmpty = false,
  empty,
  children,
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  loading: boolean;
  notConnected?: boolean;
  isEmpty?: boolean;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card text-card-foreground animate-in fade-in duration-150">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-medium">{title}</h2>
      </header>
      <div className="p-2">
        {loading ? (
          <div className="grid gap-2 p-1">
            <div className="h-7 animate-pulse rounded-md bg-muted" />
            <div className="h-7 animate-pulse rounded-md bg-muted" />
            <div className="h-7 w-2/3 animate-pulse rounded-md bg-muted" />
          </div>
        ) : notConnected ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            <Link to="/settings" className="underline underline-offset-2 transition-colors hover:text-foreground">
              Connect Google
            </Link>{' '}
            to see this.
          </p>
        ) : isEmpty ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">{empty}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
