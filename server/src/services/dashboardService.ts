import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projects, taskColumns, tasks } from '../db/schema/index.js';
import { AppError } from '../middleware/errorHandler.js';
import type { AiUsageRecord } from './aiBudgetService.js';
import { completeText } from './aiService.js';
import { listEvents } from './calendarService.js';
import { listMyDms, listVisibleChannels } from './channelService.js';
import { listFiles } from './driveService.js';
import type { CalendarEvent, DriveFile } from './google/port.js';
import { getUnreadCounts } from './messageService.js';
import { visibilityCondition } from './projectService.js';

/**
 * The "Today" dashboard: one aggregate of what already exists elsewhere.
 *
 * Nothing here has visibility logic of its own — channels and unread counts
 * come from the exact service functions the sidebar uses, tickets and projects
 * reuse `projectService.visibilityCondition` (invariant 1), and the two Google
 * sections run on the caller's own connection through the same services the
 * /calendar and /drive pages call. Notes are deliberately absent: they are
 * owner-private and out of AI reach (invariant 2), so the dashboard neither
 * queries nor summarizes them.
 *
 * Date windows ("created today", "last 7 days") are evaluated by MySQL
 * (CURDATE()/NOW()), never by comparing a TIMESTAMP column to a JS Date —
 * see invariant 10 and aiBudgetService for why.
 */

export interface UnreadChannelEntry {
  id: number;
  name: string;
  kind: 'standard' | 'support';
  unreadCount: number;
}

export interface UnreadDmEntry {
  id: number;
  displayName: string;
  unreadCount: number;
}

export interface NewTicketEntry {
  id: number;
  title: string;
  projectId: number;
  projectName: string;
  columnName: string | null;
}

export interface NewProjectEntry {
  id: number;
  name: string;
  isPrivate: boolean;
}

export interface TodayDashboard {
  /** Null when the caller has no usable Google connection — not an error. */
  events: CalendarEvent[] | null;
  /** Null when the caller has no usable Google connection — not an error. */
  sharedFiles: DriveFile[] | null;
  unread: { channels: UnreadChannelEntry[]; dms: UnreadDmEntry[] };
  newTickets: NewTicketEntry[];
  newProjects: NewProjectEntry[];
}

const SHARED_FILES_LIMIT = 10;

/**
 * A missing/broken/under-scoped Google connection must not 409 the whole
 * dashboard: the section renders as "connect Google" and everything else
 * still loads. Any non-Google failure still throws — that IS an error.
 */
async function googleSectionOrNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && err.code.startsWith('google_')) return null;
    throw err;
  }
}

async function todaysEvents(userId: number): Promise<CalendarEvent[] | null> {
  // Calendar events live in Google, not our database, so this is the one
  // "today" that has to be computed in JS: the server's local midnight.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return googleSectionOrNull(() => listEvents(userId, start.toISOString(), end.toISOString()));
}

async function recentSharedFiles(userId: number): Promise<DriveFile[] | null> {
  return googleSectionOrNull(async () => {
    // The real port orders by sharedWithMeTime desc, so the first page's head
    // is already "most recently shared".
    const { files } = await listFiles(userId, { sharedWithMe: true });
    return files.slice(0, SHARED_FILES_LIMIT);
  });
}

/** Channels and DMs with something unread — the sidebar's own service calls, filtered. */
async function unreadFor(
  userId: number,
  isAdmin: boolean,
): Promise<TodayDashboard['unread']> {
  const [channelList, dms, unread] = await Promise.all([
    listVisibleChannels(userId, isAdmin),
    listMyDms(userId),
    getUnreadCounts(userId),
  ]);
  return {
    channels: channelList
      .filter((c) => (unread[c.id] ?? 0) > 0)
      .map((c) => ({ id: c.id, name: c.name ?? '', kind: c.kind, unreadCount: unread[c.id] })),
    dms: dms
      .filter((d) => (unread[d.id] ?? 0) > 0)
      .map((d) => ({
        id: d.id,
        displayName: d.user?.displayName ?? 'Unknown person',
        unreadCount: unread[d.id],
      })),
  };
}

/** Support-intake tickets filed today, in projects the caller can see. */
async function todaysSupportTickets(userId: number, isAdmin: boolean): Promise<NewTicketEntry[]> {
  const conditions = [
    eq(tasks.source, 'support'),
    sql`DATE(${tasks.createdAt}) = CURDATE()`,
    ...(isAdmin ? [] : [visibilityCondition(userId)]),
  ];
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      projectId: tasks.projectId,
      projectName: projects.name,
      columnName: taskColumns.name,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(taskColumns, eq(taskColumns.id, tasks.columnId))
    .where(and(...conditions))
    .orderBy(desc(tasks.id))
    .limit(50);
}

/** Projects created in the last 7 days that the caller can see. */
async function recentProjects(userId: number, isAdmin: boolean): Promise<NewProjectEntry[]> {
  const conditions = [
    sql`${projects.createdAt} >= NOW() - INTERVAL 7 DAY`,
    ...(isAdmin ? [] : [visibilityCondition(userId)]),
  ];
  return db
    .select({ id: projects.id, name: projects.name, isPrivate: projects.isPrivate })
    .from(projects)
    .where(and(...conditions))
    .orderBy(desc(projects.createdAt))
    .limit(50);
}

export async function getTodayDashboard(userId: number, isAdmin: boolean): Promise<TodayDashboard> {
  const [events, sharedFiles, unread, newTickets, newProjects] = await Promise.all([
    todaysEvents(userId),
    recentSharedFiles(userId),
    unreadFor(userId, isAdmin),
    todaysSupportTickets(userId, isAdmin),
    recentProjects(userId, isAdmin),
  ]);
  return { events, sharedFiles, unread, newTickets, newProjects };
}

// ─── AI summary ──────────────────────────────────────────────────────────────
// A paid AI call like triage, so it runs on the SAME provider-switchable setup
// triage uses (AI_PROVIDER / AI_MODEL / the provider's key), through
// aiService.completeText — not a Claude-only path of its own. The onUsage
// contract matches the triage providers: report a dispatched call exactly
// once, whatever it returned, because it is billable either way. The budget
// gate and the ai_usage row live in the route (invariant 7).

/** Shown only when NO provider at all is configured. */
export const AI_NOT_CONFIGURED =
  'No AI provider is configured (set the API key for the provider AI_PROVIDER selects)';

// Reasoning models spend hidden thinking tokens inside this cap, so it is
// sized well above the few sentences the reply itself needs.
const MAX_TOKENS = 4096;

/**
 * The prompt carries counts and titles/names/subjects only — never a message
 * body, never a file's contents, and never anything from notes (which this
 * whole module does not touch).
 */
export function buildSummaryPrompt(d: TodayDashboard): string {
  const section = (label: string, items: string[]): string =>
    items.length === 0 ? `${label}: none.` : `${label} (${items.length}):\n- ${items.join('\n- ')}`;

  const parts = ["Summarize this person's day:", ''];
  parts.push(
    d.events === null
      ? 'Calendar: not connected.'
      : section(
          "Today's calendar events",
          d.events.map((e) => `${e.allDay ? 'all day' : e.start} ${e.title}`),
        ),
  );
  parts.push(
    section(
      'Unread conversations',
      [
        ...d.unread.channels.map((c) => `#${c.name}: ${c.unreadCount} unread`),
        ...d.unread.dms.map((m) => `DM with ${m.displayName}: ${m.unreadCount} unread`),
      ],
    ),
  );
  parts.push(
    d.sharedFiles === null
      ? 'Drive: not connected.'
      : section(
          'Recently shared files',
          d.sharedFiles.map((f) => `${f.name}${f.owner ? ` (from ${f.owner})` : ''}`),
        ),
  );
  parts.push(
    section(
      'Support tickets filed today',
      d.newTickets.map((t) => `${t.title} [${t.projectName}]`),
    ),
  );
  parts.push(section('New projects this week', d.newProjects.map((p) => p.name)));
  return parts.join('\n');
}

const SUMMARY_SYSTEM_PROMPT = [
  'You write a short daily briefing for a staff member of an internal ops tool.',
  'You are given only counts and titles — summarize what their day looks like and',
  'what deserves attention first, in 2 to 4 plain-text sentences. No markdown, no',
  'lists, no preamble; skip sections that are empty rather than mentioning them.',
].join(' ');

export async function summarizeDay(
  dashboard: TodayDashboard,
  onUsage?: (usage: AiUsageRecord) => void,
): Promise<string> {
  return completeText({
    system: SUMMARY_SYSTEM_PROMPT,
    prompt: buildSummaryPrompt(dashboard),
    maxTokens: MAX_TOKENS,
    onUsage,
  });
}
