import Anthropic from '@anthropic-ai/sdk';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { routineRuns, routines } from '../db/schema/index.js';
import { logger } from '../logger.js';
import { recordAiUsage } from './aiBudgetService.js';
import { channelForWriting, type Caller } from './access.js';
// The tools are shared with the MCP endpoint, defined once in agentTools.
import { isRefusal, jsonSchemaFor, toolsForScopes } from './agentTools.js';
import { getBotUserId } from './botService.js';
import { findOrCreateDm } from './channelService.js';
import { sendMessage } from './messageService.js';

export type RoutineRow = typeof routines.$inferSelect;
export type RoutineRunRow = typeof routineRuns.$inferSelect;

/**
 * The agentic loop behind AI Routines.
 *
 * A routine acts with nobody watching, so everything here is about bounding it:
 *
 * - **Scopes.** A tool is offered only if the routine holds its scope, and the
 *   check is repeated inside the handler. The prompt cannot talk its way past it.
 * - **Iterations.** The loop stops after MAX_ITERATIONS whatever the model wants.
 * - **Tokens.** A budget per run, checked between turns; exceeding it ends the
 *   run as `budget_exceeded`, which is not a failure — it is the allowance doing
 *   its job, and it tells the owner to raise the cap rather than debug the prompt.
 * - **Identity.** Every write is attributed to the bot user, exactly as an MCP
 *   token's writes are, so the audit trail reads the same for both.
 *
 * Authorization lives in agentAuth, shared with the MCP endpoint, so the two
 * agent surfaces cannot drift apart.
 */

const MAX_ITERATIONS = 8;
const MAX_TOKENS_PER_RUN = 60_000;
const MODEL = 'claude-opus-5';
const MAX_TOKENS_PER_TURN = 4096;

let client: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (client !== undefined) return client;
  client = config.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }) : null;
  return client;
}

/** Test seam: lets a suite drive the loop without an API key or a network call. */
export function setRoutineClient(next: Anthropic | null): void {
  client = next;
}

function systemPrompt(routine: RoutineRow): string {
  return [
    'You are an automation running on a schedule inside a company workspace.',
    'Nobody is watching this run, so do exactly what the task asks and nothing more.',
    'Use the tools available to you. If a tool refuses, do not try to work around it —',
    'the refusal is the boundary of what this routine is permitted to do.',
    'When you are finished, reply with a short plain-text summary of what you did.',
    `The routine is called "${routine.name}".`,
  ].join(' ');
}

export async function runRoutine(
  routine: RoutineRow,
  trigger: 'schedule' | 'manual',
): Promise<RoutineRunRow> {
  const [{ id: runId }] = await db
    .insert(routineRuns)
    .values({ routineId: routine.id, trigger, status: 'running' })
    .$returningId();

  const transcript: unknown[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let iterations = 0;

  const finish = async (
    status: 'succeeded' | 'failed' | 'budget_exceeded',
    extra: { summary?: string; error?: string } = {},
  ): Promise<RoutineRunRow> => {
    await db
      .update(routineRuns)
      .set({
        status,
        transcript,
        summary: extra.summary ?? null,
        error: extra.error ?? null,
        inputTokens,
        outputTokens,
        iterations,
        finishedAt: sql`NOW()`,
      })
      .where(eq(routineRuns.id, runId));
    const [row] = await db.select().from(routineRuns).where(eq(routineRuns.id, runId));
    return row;
  };

  const anthropic = getClient();
  if (!anthropic) {
    return finish('failed', { error: 'No AI provider is configured (ANTHROPIC_API_KEY unset)' });
  }

  const botUserId = await getBotUserId();
  if (botUserId === null) {
    return finish('failed', { error: 'No bot user is seeded, so a routine has no identity to act as' });
  }
  // A routine acts as the bot, never as its owner: its writes must be
  // attributable to an automation, and it must not inherit a person's memberships.
  const caller: Caller = { userId: botUserId, isAdmin: false };

  // Unattended-only: a routine runs with nobody watching, so it is offered the
  // verbs that make sense on a schedule rather than the full agent surface an
  // MCP client (which has a person driving it) receives.
  const tools = toolsForScopes(routine.scopes, { unattendedOnly: true });
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: routine.prompt }];

  try {
    while (iterations < MAX_ITERATIONS) {
      if (inputTokens + outputTokens >= MAX_TOKENS_PER_RUN) {
        return finish('budget_exceeded', {
          summary: 'Stopped: this run reached its token allowance.',
        });
      }
      iterations++;

      const response = await anthropic.messages.create({
        model: config.AI_MODEL || MODEL,
        max_tokens: MAX_TOKENS_PER_TURN,
        system: systemPrompt(routine),
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          // Derived from the same zod shape the MCP endpoint registers, so the
          // two surfaces cannot describe the same tool differently.
          input_schema: jsonSchemaFor(t) as Anthropic.Tool.InputSchema,
        })),
        messages,
      });

      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      // Routines are a paid AI call like triage, so they land in the same ledger —
      // one place answers "what did AI cost us".
      await recordAiUsage(routine.outputChannelId ?? 0, {
        provider: 'anthropic',
        model: config.AI_MODEL || MODEL,
        promptTokens: response.usage?.input_tokens ?? 0,
        completionTokens: response.usage?.output_tokens ?? 0,
      }).catch(() => undefined);

      const textParts = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text);
      if (textParts.length) transcript.push({ type: 'text', text: textParts.join('\n') });

      const toolUses = response.content.filter(
        (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use',
      );
      if (toolUses.length === 0) {
        const summary = textParts.join('\n').trim();
        await postSummary(routine, summary, botUserId);
        return finish('succeeded', { summary });
      }

      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const use of toolUses) {
        const tool = tools.find((t) => t.name === use.name);
        transcript.push({ type: 'tool_use', name: use.name, input: use.input });
        let output: unknown;
        if (!tool) {
          // Either a hallucinated name or a tool this routine's scopes exclude.
          output = { error: `No tool named ${use.name} is available to this routine.` };
        } else {
          try {
            const result = await tool.handler(use.input as never, caller);
            // A refusal is a result the model should reason about, not a crash.
            output = isRefusal(result) ? { error: result.refusal } : result;
          } catch (err) {
            output = { error: err instanceof Error ? err.message : 'The tool failed' };
          }
        }
        transcript.push({ type: 'tool_result', name: use.name, output });
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(output).slice(0, 20_000),
        });
      }
      messages.push({ role: 'user', content: results });
    }

    // Out of iterations: succeeded is the wrong word, but so is failed — say what happened.
    return finish('failed', {
      error: `Stopped after ${MAX_ITERATIONS} steps without finishing.`,
    });
  } catch (err) {
    logger.error({ err, routineId: routine.id }, 'routine run failed');
    const message = err instanceof Error ? err.message : 'The routine failed';
    await notifyOwner(routine, message, botUserId);
    return finish('failed', { error: message });
  }
}

/** Post the summary where the owner asked for it, if they asked at all. */
async function postSummary(routine: RoutineRow, summary: string, botUserId: number): Promise<void> {
  if (!routine.outputChannelId || !summary) return;
  const allowed = await channelForWriting(routine.outputChannelId, {
    userId: botUserId,
    isAdmin: false,
  });
  if (!allowed) {
    logger.warn(
      { routineId: routine.id, channelId: routine.outputChannelId },
      'routine output channel is not writable by the bot',
    );
    return;
  }
  await sendMessage(routine.outputChannelId, botUserId, summary);
}

/**
 * Tell the owner when their routine broke.
 *
 * A scheduled task that fails silently is worse than one that never ran: it looks
 * like it is working. The DM is best-effort — a failure to report a failure must
 * not become the thing that throws.
 */
async function notifyOwner(routine: RoutineRow, message: string, botUserId: number): Promise<void> {
  try {
    const dm = await findOrCreateDm(botUserId, routine.ownerId);
    await sendMessage(dm.id, botUserId, `Routine "${routine.name}" failed: ${message}`);
  } catch (err) {
    logger.warn({ err, routineId: routine.id }, 'could not notify the routine owner');
  }
}
