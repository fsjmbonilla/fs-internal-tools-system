/**
 * The MCP endpoint: the same platform, addressed by an agent instead of a browser.
 *
 * Design rule for this whole directory: **no business logic here.** Every tool is
 * a thin wrapper that calls the same service the REST route calls, after the same
 * visibility and membership checks. A tool that reimplements a rule is a tool that
 * will drift away from it, and the rules here are the privacy ones.
 *
 * Two consequences worth stating up front:
 *
 * - There is no notes tool, and no scope that could enable one. Notes are private
 *   to their owner and unreachable by any token (see routes/notes.ts).
 * - The tool list is built per request from the calling token's scopes, so an agent
 *   is not shown a tool it would be refused. Scopes are still checked inside each
 *   handler — the filtered list is ergonomics, the check is the boundary.
 */

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Router } from 'express';
// zod/v4, not the app's zod v3 import: the MCP SDK needs Standard-Schema types
// that can emit JSON Schema for the tool manifest, which v3 schemas cannot. zod
// 3.25 ships both, and nothing is shared between this layer and the route schemas.
import * as z from 'zod/v4';
import type { AuthContext } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../logger.js';
import type { Scope } from '../services/apiTokenService.js';
import { getVisibleChannel, isChannelMember, listVisibleChannels } from '../services/channelService.js';
import { createDoc, getDoc, getDocWithAttachments, listDocs, updateDoc } from '../services/docService.js';
import { searchMessages, sendMessage } from '../services/messageService.js';
import { getVisibleProject, isProjectMember, listVisibleProjects } from '../services/projectService.js';
import {
  createTask,
  getBoard,
  getTaskById,
  moveTask,
  updateTask,
} from '../services/taskService.js';

/** What every tool handler is given: who is calling, and what they may do. */
interface Caller {
  userId: number;
  isAdmin: boolean;
  scopes: Scope[];
}

/** A tool result. MCP wants text content; JSON is what an agent can act on. */
type ToolResult = {
  isError?: boolean;
  content: { type: 'text'; text: string }[];
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * A refusal the model can read.
 *
 * `isError` rather than a thrown exception: the agent should see "you cannot see
 * that" as a result it can reason about, not as a transport failure. The wording
 * is deliberately the same "not found" a REST caller gets — invisibility is not
 * relaxed because the caller is an LLM that would like more detail.
 */
function refuse(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

const NOT_FOUND = 'Not found, or not visible to this token.';

/** Visibility, then membership — the order every REST route uses. */
async function projectForWriting(projectId: number, caller: Caller) {
  const project = await getVisibleProject(projectId, caller.userId, caller.isAdmin);
  if (!project) return null;
  if (!caller.isAdmin && !(await isProjectMember(projectId, caller.userId))) return null;
  return project;
}

async function projectForReading(projectId: number, caller: Caller) {
  return getVisibleProject(projectId, caller.userId, caller.isAdmin);
}

/**
 * Build the server for one request.
 *
 * Per-request rather than once at boot, because the tool list depends on the
 * caller's scopes and because a fresh instance cannot leak one token's identity
 * into another's exchange. Registering ten tools costs microseconds; MCP traffic
 * is low-volume and this is the cheap half of the request.
 */
export function buildMcpServer(caller: Caller): McpServer {
  const server = new McpServer({ name: 'fs-internal-tools', version: '1.0.0' });
  const has = (scope: Scope) => caller.scopes.includes(scope);

  /** Register only if the token holds the scope; check it again at call time. */
  function tool<Shape extends z.ZodRawShape>(
    scope: Scope,
    name: string,
    description: string,
    shape: Shape,
    handler: (input: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
  ) {
    if (!has(scope)) return;
    const inputSchema = z.object(shape);
    server.registerTool(name, { description, inputSchema }, async (input) => {
      // Belt and braces. The list was filtered by scope, but the check that
      // matters is the one on the path that does the work.
      if (!has(scope)) return refuse(`This token lacks the ${scope} scope.`);
      return handler(input);
    });
  }

  // ─── Tickets ────────────────────────────────────────────────────────────────

  tool(
    'tickets:read',
    'list_projects',
    'List the projects this token can see. Use the returned id with list_tickets.',
    {},
    async () => ok({ projects: await listVisibleProjects(caller.userId, caller.isAdmin) }),
  );

  tool(
    'tickets:read',
    'list_tickets',
    'List the board columns and tickets of a project.',
    { projectId: z.number().int().positive() },
    async ({ projectId }) => {
      if (!(await projectForReading(projectId, caller))) return refuse(NOT_FOUND);
      return ok(await getBoard(projectId));
    },
  );

  tool(
    'tickets:read',
    'get_ticket',
    'Read one ticket by id.',
    { ticketId: z.number().int().positive() },
    async ({ ticketId }) => {
      const task = await getTaskById(ticketId);
      if (!task || !(await projectForReading(task.projectId, caller))) return refuse(NOT_FOUND);
      return ok(task);
    },
  );

  tool(
    'tickets:write',
    'create_ticket',
    'Create a ticket in a project column. Attributed to this token\'s bot user.',
    {
      projectId: z.number().int().positive(),
      columnId: z.number().int().positive(),
      title: z.string().min(1).max(300),
      description: z.string().max(10000).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    },
    async (input) => {
      if (!(await projectForWriting(input.projectId, caller))) return refuse(NOT_FOUND);
      // The column has to belong to the project the caller was authorized for,
      // or the id becomes a way to write into a project it never named.
      const board = await getBoard(input.projectId);
      if (!board.columns.some((c) => c.id === input.columnId)) {
        return refuse('That column does not belong to that project.');
      }
      const task = await createTask({ ...input, createdBy: caller.userId });
      return ok(task);
    },
  );

  tool(
    'tickets:write',
    'update_ticket',
    'Change a ticket\'s title, description, assignee, or due date.',
    {
      ticketId: z.number().int().positive(),
      title: z.string().min(1).max(300).optional(),
      description: z.string().max(10000).nullable().optional(),
      assigneeId: z.number().int().positive().nullable().optional(),
      dueDate: z.string().date().nullable().optional(),
    },
    async ({ ticketId, ...patch }) => {
      const task = await getTaskById(ticketId);
      if (!task || !(await projectForWriting(task.projectId, caller))) return refuse(NOT_FOUND);
      return ok(await updateTask(ticketId, patch));
    },
  );

  tool(
    'tickets:write',
    'move_ticket_status',
    'Move a ticket to another column. Announces the change in the channel the ticket came from, exactly as a person moving it would.',
    {
      ticketId: z.number().int().positive(),
      columnId: z.number().int().positive(),
    },
    async ({ ticketId, columnId }) => {
      const task = await getTaskById(ticketId);
      if (!task || !(await projectForWriting(task.projectId, caller))) return refuse(NOT_FOUND);
      const board = await getBoard(task.projectId);
      if (!board.columns.some((c) => c.id === columnId)) {
        return refuse('That column does not belong to that ticket\'s project.');
      }
      // moveTask owns the origin-channel announcement. Calling it — rather than
      // reimplementing the move — is what makes an agent's move indistinguishable
      // from a person's to everyone watching the channel.
      await moveTask(ticketId, columnId, undefined, undefined, caller.userId);
      return ok(await getTaskById(ticketId));
    },
  );

  // ─── Chat ───────────────────────────────────────────────────────────────────

  tool(
    'chat:read',
    'list_channels',
    'List the channels this token can see.',
    {},
    async () => ok({ channels: await listVisibleChannels(caller.userId, caller.isAdmin) }),
  );

  tool(
    'chat:read',
    'search_messages',
    'Full-text search across visible channels.',
    {
      query: z.string().min(1).max(200),
      channelId: z.number().int().positive().optional(),
    },
    async ({ query, channelId }) =>
      ok({ messages: await searchMessages(caller.userId, caller.isAdmin, query, channelId) }),
  );

  tool(
    'chat:write',
    'post_message',
    'Post a message to a channel this token is a member of.',
    {
      channelId: z.number().int().positive(),
      body: z.string().min(1).max(4000),
    },
    async ({ channelId, body }) => {
      if (!(await getVisibleChannel(channelId, caller.userId, caller.isAdmin))) {
        return refuse(NOT_FOUND);
      }
      // Membership, not just visibility: posting into a public channel it never
      // joined would let an agent talk anywhere it can see.
      if (!caller.isAdmin && !(await isChannelMember(channelId, caller.userId))) {
        return refuse(NOT_FOUND);
      }
      return ok(await sendMessage(channelId, caller.userId, body));
    },
  );

  // ─── Docs ───────────────────────────────────────────────────────────────────

  tool(
    'docs:read',
    'list_docs',
    'List the documents in a project.',
    { projectId: z.number().int().positive() },
    async ({ projectId }) => {
      if (!(await projectForReading(projectId, caller))) return refuse(NOT_FOUND);
      return ok({ docs: await listDocs(projectId) });
    },
  );

  tool(
    'docs:read',
    'read_doc',
    'Read one document by id.',
    { docId: z.number().int().positive() },
    async ({ docId }) => {
      const doc = await getDoc(docId);
      if (!doc || !(await projectForReading(doc.projectId, caller))) return refuse(NOT_FOUND);
      return ok(await getDocWithAttachments(docId));
    },
  );

  tool(
    'docs:write',
    'write_doc',
    'Create a document in a project, or replace the title/content of an existing one.',
    {
      projectId: z.number().int().positive().optional(),
      docId: z.number().int().positive().optional(),
      title: z.string().min(1).max(200).optional(),
      content: z.string().max(200000).optional(),
    },
    async ({ projectId, docId, title, content }) => {
      if (docId) {
        const doc = await getDoc(docId);
        if (!doc || !(await projectForWriting(doc.projectId, caller))) return refuse(NOT_FOUND);
        await updateDoc(docId, { title, content }, caller.userId);
        return ok(await getDocWithAttachments(docId));
      }
      if (!projectId || !title) {
        return refuse('Creating a document needs projectId and title; updating one needs docId.');
      }
      if (!(await projectForWriting(projectId, caller))) return refuse(NOT_FOUND);
      return ok(await createDoc({ projectId, title, content, userId: caller.userId }));
    },
  );

  return server;
}

export const mcpRouter = Router();

/**
 * Service tokens only.
 *
 * A person's JWT is refused here even though requireAuth would accept it: the
 * endpoint exists for agents, a browser session has the whole REST API, and
 * allowing both would mean a stolen JWT gains a second, differently-shaped
 * surface. It also keeps `caller.scopes` honest — a user has no scopes, so a user
 * on this endpoint would either see no tools or need a bypass, and a bypass here
 * is exactly the hole worth not opening.
 */
mcpRouter.all('/', requireAuth, async (req, res) => {
  const auth = req.auth as AuthContext;
  if (auth.kind !== 'token') {
    throw new AppError(401, 'unauthenticated', 'The MCP endpoint requires a service token');
  }

  const caller: Caller = {
    userId: auth.userId,
    isAdmin: auth.role === 'admin',
    scopes: auth.scopes ?? [],
  };

  const handler = createMcpHandler(() => buildMcpServer(caller));
  try {
    // The adapter would forward `req.auth` as OAuth `AuthInfo`; ours is this
    // platform's AuthContext, which is a different thing, so the caller reaches
    // the tools by closure instead and this cast is only about that shape
    // mismatch at the seam.
    await toNodeHandler(handler, {
      onerror: (error) => logger.error({ err: error }, 'MCP adapter error'),
    })(req as unknown as NodeIncomingMessageLike, res, req.body);
  } finally {
    // Per-request handler, so it has to be per-request cleanup too.
    await handler.close();
  }
});
