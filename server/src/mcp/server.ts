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
// The tools themselves — shared with AI Routines, defined exactly once.
import { AGENT_TOOLS, isRefusal } from '../services/agentTools.js';
// Shared with AI routines: one place decides what an agent may reach.

/** What every tool handler is given: who is calling, and what they may do. */
interface Caller {
  userId: number;
  isAdmin: boolean;
  scopes: Scope[];
  /** The token creator — whose Google connection the Google tools use. */
  googleUserId?: number;
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

  /**
   * Register every shared tool this token holds the scope for.
   *
   * The tools themselves live in `services/agentTools.ts` because AI Routines
   * offer the same verbs, and a tool defined in two places is a tool whose two
   * definitions will eventually disagree. This layer does one job: translate a
   * shared tool into what the MCP SDK wants, and turn a refusal into an MCP
   * error result.
   */
  for (const definition of AGENT_TOOLS) {
    if (!has(definition.scope)) continue;
    const inputSchema = z.object(definition.shape);
    server.registerTool(
      definition.name,
      { description: definition.description, inputSchema },
      async (input) => {
        // Belt and braces. The list was filtered by scope, but the check that
        // matters is the one on the path that does the work.
        if (!has(definition.scope)) return refuse(`This token lacks the ${definition.scope} scope.`);
        const result = await definition.handler(input as never, caller);
        return isRefusal(result) ? refuse(result.refusal) : ok(result);
      },
    );
  }

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
    // Google tools act on the connection of the person who minted this token —
    // an MCP client is person-driven, and the minter is the person who chose
    // to grant it google scopes.
    googleUserId: auth.tokenCreatedBy,
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
