// zod/v4, matching the MCP layer: the SDK needs Standard-Schema types that can
// emit JSON Schema, and the Anthropic tool definitions are derived from the same
// shapes via z.toJSONSchema(). Nothing here is shared with the v3 route schemas.
import * as z from 'zod/v4';
import type { Scope } from './apiTokenService.js';
import { channelForWriting, projectForReading, projectForWriting, type Caller } from './access.js';
import { listVisibleChannels } from './channelService.js';
import { listVisibleProjects } from './projectService.js';
import { createDoc, getDoc, getDocWithAttachments, listDocs, updateDoc } from './docService.js';
import { searchMessages, sendMessage } from './messageService.js';
import {
  canWrite,
  createSheet,
  getLock,
  getSheet,
  getSheetSummary,
  isWorkbookSnapshot,
  listSheets,
  updateSheet,
} from './sheetService.js';
import { createTask, getBoard, getTaskById, moveTask, updateTask } from './taskService.js';
import {
  createEvent as createCalendarEvent,
  listEvents as listCalendarEvents,
} from './calendarService.js';
import { listFiles as listDriveFiles } from './driveService.js';
import { listMail, sendMail } from './gmailService.js';
import { AppError } from '../middleware/errorHandler.js';
import { getIo } from '../sockets/registry.js';

/**
 * Every tool an agent can call, defined exactly once.
 *
 * There are two agent surfaces — the MCP endpoint (a service token, driven by an
 * external client) and AI Routines (a schedule, driven by the model) — and they
 * must offer the *same* verbs under the *same* rules. Defining a tool twice is
 * how those two drift apart, which is the failure the MCP module warns about in
 * its own header. So the definition lives here and each surface only adapts it:
 * MCP registers the zod shape directly, routines derive JSON Schema from it.
 *
 * Authorization is not re-implemented here either — it comes from `agentAuth`,
 * which the REST routes' own rules are mirrored into.
 *
 * A handler returns plain data, or a `Refusal`. Refusals are values rather than
 * exceptions because an agent should be able to reason about "you cannot see
 * that" as a result, not as a transport failure.
 */

export interface Refusal {
  refusal: string;
}

export function refusal(message: string): Refusal {
  return { refusal: message };
}

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === 'object' && value !== null && 'refusal' in value;
}

export const NOT_FOUND = 'Not found, or not visible to this caller.';

export interface AgentTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  scope: Scope;
  name: string;
  description: string;
  shape: Shape;
  /**
   * May a *routine* use this tool?
   *
   * A routine runs unattended, so it gets the verbs that make sense on a
   * schedule and not the ones whose damage is hard to notice. This is a
   * deliberate curation, not an oversight — an MCP client has a person driving
   * it and can have the fuller set.
   */
  unattended: boolean;
  handler: (input: Record<string, never>, caller: Caller) => Promise<unknown>;
}

/** Narrow, so each handler can read its own input without casting at every use. */
function tool<Shape extends z.ZodRawShape>(
  definition: Omit<AgentTool<Shape>, 'handler'> & {
    handler: (input: z.infer<z.ZodObject<Shape>>, caller: Caller) => Promise<unknown>;
  },
): AgentTool {
  return definition as unknown as AgentTool;
}

export const AGENT_TOOLS: AgentTool[] = [
  // ─── Tickets ────────────────────────────────────────────────────────────────
  tool({
    scope: 'tickets:read',
    name: 'list_projects',
    description: 'List the projects this caller can see. Use the returned id with list_tickets.',
    shape: {},
    unattended: true,
    handler: async (_input, caller) => ({
      projects: await listVisibleProjects(caller.userId, caller.isAdmin),
    }),
  }),

  tool({
    scope: 'tickets:read',
    name: 'list_tickets',
    description: 'List the board columns and tickets of a project.',
    shape: { projectId: z.number().int().positive() },
    unattended: true,
    handler: async ({ projectId }, caller) => {
      if (!(await projectForReading(projectId, caller))) return refusal(NOT_FOUND);
      return getBoard(projectId);
    },
  }),

  tool({
    scope: 'tickets:read',
    name: 'get_ticket',
    description: 'Read one ticket by id.',
    shape: { ticketId: z.number().int().positive() },
    unattended: true,
    handler: async ({ ticketId }, caller) => {
      const task = await getTaskById(ticketId);
      if (!task || !(await projectForReading(task.projectId, caller))) return refusal(NOT_FOUND);
      return task;
    },
  }),

  tool({
    scope: 'tickets:write',
    name: 'create_ticket',
    description: "Create a ticket in a project column. Attributed to the caller's bot user.",
    shape: {
      projectId: z.number().int().positive(),
      columnId: z.number().int().positive(),
      title: z.string().min(1).max(300),
      description: z.string().max(10000).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    },
    unattended: true,
    handler: async (input, caller) => {
      if (!(await projectForWriting(input.projectId, caller))) return refusal(NOT_FOUND);
      // The column has to belong to the project the caller was authorized for,
      // or the id becomes a way to write into a project it never named.
      const board = await getBoard(input.projectId);
      if (!board.columns.some((c) => c.id === input.columnId)) {
        return refusal('That column does not belong to that project.');
      }
      return createTask({ ...input, createdBy: caller.userId });
    },
  }),

  tool({
    scope: 'tickets:write',
    name: 'update_ticket',
    description: "Change a ticket's title, description, assignee, or due date.",
    shape: {
      ticketId: z.number().int().positive(),
      title: z.string().min(1).max(300).optional(),
      description: z.string().max(10000).nullable().optional(),
      assigneeId: z.number().int().positive().nullable().optional(),
      dueDate: z.string().date().nullable().optional(),
    },
    unattended: false,
    handler: async ({ ticketId, ...patch }, caller) => {
      const task = await getTaskById(ticketId);
      if (!task || !(await projectForWriting(task.projectId, caller))) return refusal(NOT_FOUND);
      return updateTask(ticketId, patch);
    },
  }),

  tool({
    scope: 'tickets:write',
    name: 'move_ticket_status',
    description:
      'Move a ticket to another column. Announces the change in the channel the ticket came from, exactly as a person moving it would.',
    shape: {
      ticketId: z.number().int().positive(),
      columnId: z.number().int().positive(),
    },
    unattended: true,
    handler: async ({ ticketId, columnId }, caller) => {
      const task = await getTaskById(ticketId);
      if (!task || !(await projectForWriting(task.projectId, caller))) return refusal(NOT_FOUND);
      const board = await getBoard(task.projectId);
      if (!board.columns.some((c) => c.id === columnId)) {
        return refusal("That column does not belong to that ticket's project.");
      }
      // moveTask owns the origin-channel announcement. Calling it — rather than
      // reimplementing the move — is what makes an agent's move indistinguishable
      // from a person's to everyone watching the channel.
      await moveTask(ticketId, columnId, undefined, undefined, caller.userId);
      return getTaskById(ticketId);
    },
  }),

  // ─── Chat ───────────────────────────────────────────────────────────────────
  tool({
    scope: 'chat:read',
    name: 'list_channels',
    description: 'List the channels this caller can see.',
    shape: {},
    unattended: true,
    handler: async (_input, caller) => ({
      channels: await listVisibleChannels(caller.userId, caller.isAdmin),
    }),
  }),

  tool({
    scope: 'chat:read',
    name: 'search_messages',
    description: 'Full-text search across visible channels.',
    shape: {
      query: z.string().min(1).max(200),
      channelId: z.number().int().positive().optional(),
    },
    unattended: true,
    handler: async ({ query, channelId }, caller) => ({
      messages: await searchMessages(caller.userId, caller.isAdmin, query, channelId),
    }),
  }),

  tool({
    scope: 'chat:write',
    name: 'post_message',
    description: 'Post a message to a channel this caller is a member of.',
    shape: {
      channelId: z.number().int().positive(),
      body: z.string().min(1).max(4000),
    },
    unattended: true,
    handler: async ({ channelId, body }, caller) => {
      // Membership, not just visibility: posting into a public channel it never
      // joined would let an agent talk anywhere it can see.
      if (!(await channelForWriting(channelId, caller))) return refusal(NOT_FOUND);
      return sendMessage(channelId, caller.userId, body);
    },
  }),

  // ─── Docs ───────────────────────────────────────────────────────────────────
  tool({
    scope: 'docs:read',
    name: 'list_docs',
    description: 'List the documents in a project.',
    shape: { projectId: z.number().int().positive() },
    unattended: true,
    handler: async ({ projectId }, caller) => {
      if (!(await projectForReading(projectId, caller))) return refusal(NOT_FOUND);
      return { docs: await listDocs(projectId) };
    },
  }),

  tool({
    scope: 'docs:read',
    name: 'read_doc',
    description: 'Read one document by id.',
    shape: { docId: z.number().int().positive() },
    unattended: true,
    handler: async ({ docId }, caller) => {
      const doc = await getDoc(docId);
      if (!doc || !(await projectForReading(doc.projectId, caller))) return refusal(NOT_FOUND);
      return getDocWithAttachments(docId);
    },
  }),

  tool({
    scope: 'docs:write',
    name: 'write_doc',
    description:
      'Create a document in a project, or replace the title/content of an existing one.',
    shape: {
      projectId: z.number().int().positive().optional(),
      docId: z.number().int().positive().optional(),
      title: z.string().min(1).max(200).optional(),
      content: z.string().max(200000).optional(),
    },
    unattended: false,
    handler: async ({ projectId, docId, title, content }, caller) => {
      if (docId) {
        const doc = await getDoc(docId);
        if (!doc || !(await projectForWriting(doc.projectId, caller))) return refusal(NOT_FOUND);
        await updateDoc(docId, { title, content }, caller.userId);
        return getDocWithAttachments(docId);
      }
      if (!projectId || !title) {
        return refusal('Creating a document needs projectId and title; updating one needs docId.');
      }
      if (!(await projectForWriting(projectId, caller))) return refusal(NOT_FOUND);
      return createDoc({ projectId, title, content, userId: caller.userId });
    },
  }),

  // ─── Sheets ─────────────────────────────────────────────────────────────────
  tool({
    scope: 'sheets:read',
    name: 'list_sheets',
    description: 'List the spreadsheets in a project.',
    shape: { projectId: z.number().int().positive() },
    unattended: true,
    handler: async ({ projectId }, caller) => {
      if (!(await projectForReading(projectId, caller))) return refusal(NOT_FOUND);
      return { sheets: await listSheets(projectId) };
    },
  }),

  tool({
    scope: 'sheets:read',
    name: 'read_sheet',
    description: 'Read one spreadsheet by id, including its workbook snapshot.',
    shape: { sheetId: z.number().int().positive() },
    unattended: true,
    handler: async ({ sheetId }, caller) => {
      const sheet = await getSheet(sheetId);
      if (!sheet || !(await projectForReading(sheet.projectId, caller))) return refusal(NOT_FOUND);
      return sheet;
    },
  }),

  tool({
    scope: 'sheets:write',
    name: 'write_sheet',
    description:
      "Create a spreadsheet in a project, or replace an existing one's title/workbook snapshot.",
    shape: {
      projectId: z.number().int().positive().optional(),
      sheetId: z.number().int().positive().optional(),
      title: z.string().min(1).max(200).optional(),
      data: z.string().max(24_000_000).optional(),
    },
    unattended: false,
    handler: async ({ projectId, sheetId, title, data }, caller) => {
      if (data !== undefined && !isWorkbookSnapshot(data)) {
        return refusal('data must be a workbook snapshot (a JSON object).');
      }
      if (sheetId) {
        const sheet = await getSheetSummary(sheetId);
        if (!sheet || !(await projectForWriting(sheet.projectId, caller))) return refusal(NOT_FOUND);
        // An agent respects the edit lock like anyone else. Without this an
        // automation could overwrite whatever a person was in the middle of
        // typing, which is the one thing the lock exists to prevent.
        if (!canWrite(sheetId, caller.userId)) {
          const lock = getLock(sheetId);
          return refusal(`${lock?.displayName ?? 'Someone else'} is editing that sheet right now.`);
        }
        const updated = await updateSheet(sheetId, caller.userId, { title, data });
        if (!updated) return refusal(NOT_FOUND);
        getIo()?.to(`sheet:${sheetId}`).emit('sheet:updated', { sheetId, updatedBy: caller.userId });
        return { ...updated, data: undefined };
      }
      if (!projectId || !title) {
        return refusal('Creating a sheet needs projectId and title; updating one needs sheetId.');
      }
      if (!(await projectForWriting(projectId, caller))) return refusal(NOT_FOUND);
      const created = await createSheet({ projectId, title, data, userId: caller.userId });
      return { ...created, data: undefined };
    },
  }),

  // ─── Google (Phase 12) ──────────────────────────────────────────────────────
  // These act on the *empowering human's* Google connection (Caller.googleUserId
  // — a routine's owner, a token's creator), never on anything of the bot's.
  // A missing or broken connection is a refusal the model can read and relay,
  // not a transport error.

  tool({
    scope: 'calendar:read',
    name: 'list_calendar_events',
    description:
      "List the events on the empowering user's Google Calendar between two ISO datetimes.",
    shape: { from: z.string(), to: z.string() },
    unattended: true,
    handler: async ({ from, to }, caller) =>
      googleCall(caller, (googleUserId) => listCalendarEvents(googleUserId, from, to)),
  }),

  tool({
    scope: 'calendar:write',
    name: 'create_calendar_event',
    // Unattended on purpose (unlike send_gmail): the artifact lands on the
    // owner's own calendar where they will see it — visible, and undoable.
    description: "Create an event on the empowering user's Google Calendar. Times are ISO 8601.",
    shape: {
      title: z.string().min(1).max(300),
      start: z.string(),
      end: z.string(),
      attendees: z.array(z.string()).max(50).optional(),
      description: z.string().max(10_000).optional(),
      location: z.string().max(1000).optional(),
    },
    unattended: true,
    handler: async (input, caller) =>
      googleCall(caller, (googleUserId) => createCalendarEvent(googleUserId, input)),
  }),

  tool({
    scope: 'gmail:read',
    name: 'search_gmail',
    description:
      "Search the empowering user's Gmail inbox (Gmail query syntax). Returns sender, subject, snippet, and date per message.",
    shape: { query: z.string().max(500).optional(), pageToken: z.string().optional() },
    unattended: true,
    handler: async ({ query, pageToken }, caller) =>
      googleCall(caller, (googleUserId) => listMail(googleUserId, { q: query, pageToken })),
  }),

  tool({
    scope: 'drive:read',
    name: 'search_drive',
    description:
      "Search the empowering user's Google Drive by file name (e.g. \"last month's inventory sheet\" → search 'inventory'). Returns name, mime type, size, and a web link per file.",
    shape: { query: z.string().min(1).max(300) },
    unattended: true,
    handler: async ({ query }, caller) =>
      googleCall(caller, (googleUserId) => listDriveFiles(googleUserId, { q: query })),
  }),

  tool({
    scope: 'drive:read',
    name: 'list_drive_files',
    description:
      "List the empowering user's Google Drive — the root, or one folder's contents when folderId is given.",
    shape: { folderId: z.string().max(120).optional() },
    unattended: true,
    handler: async ({ folderId }, caller) =>
      googleCall(caller, (googleUserId) => listDriveFiles(googleUserId, { folderId })),
  }),

  tool({
    scope: 'gmail:write',
    name: 'send_gmail',
    description: "Send a plain-text email from the empowering user's Gmail address.",
    shape: {
      to: z.email(),
      subject: z.string().min(1).max(500),
      body: z.string().min(1).max(100_000),
    },
    // Outbound email to arbitrary addresses with nobody watching is exactly the
    // damage class the unattended flag exists for. MCP only.
    unattended: false,
    handler: async (input, caller) =>
      googleCall(caller, (googleUserId) => sendMail(googleUserId, input)),
  }),
];

/**
 * Run one Google-backed tool call, translating this surface's error contract:
 * the REST services throw coded 409s; an agent gets a refusal it can read.
 */
async function googleCall<T>(
  caller: Caller,
  fn: (googleUserId: number) => Promise<T>,
): Promise<T | Refusal> {
  if (caller.googleUserId === undefined) {
    return refusal('No Google account is available to this caller.');
  }
  try {
    return await fn(caller.googleUserId);
  } catch (err) {
    if (err instanceof AppError) {
      // Any coded error — a missing connection, a scope gap, rejected input —
      // is something the model should read and adapt to, not a transport
      // failure. Only genuinely unexpected errors propagate.
      return refusal(
        err.code === 'google_not_connected'
          ? 'The empowering user has not connected Google — they can do so in Settings.'
          : err.code === 'google_connection_broken'
            ? "The empowering user's Google connection is broken and needs reconnecting in Settings."
            : err.message,
      );
    }
    throw err;
  }
}

/** The tools a caller holding these scopes may use. */
export function toolsForScopes(scopes: readonly string[], opts: { unattendedOnly?: boolean } = {}) {
  return AGENT_TOOLS.filter(
    (t) => scopes.includes(t.scope) && (!opts.unattendedOnly || t.unattended),
  );
}

/** The Anthropic-shaped input schema for a tool, derived from its zod shape. */
export function jsonSchemaFor(t: AgentTool): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>;
  // The Anthropic API rejects the $schema key on a tool's input_schema.
  delete schema.$schema;
  return schema;
}
