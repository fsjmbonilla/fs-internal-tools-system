import { z } from 'zod';

/**
 * The triage contract, shared by every provider.
 *
 * Prompt and schema live here rather than in a provider so that switching
 * providers cannot quietly change what the AI is asked to decide — only how the
 * request is made. A provider that drifts from this schema fails validation and
 * the automation does nothing, which is the safe direction.
 */

export const DecisionSchema = z.object({
  // 'none' is the terminal state. Without it every human message forced either a
  // question or a ticket, so a bare "thanks!" re-triaged the whole transcript and
  // filed a duplicate — an unbounded, paid runaway with a human in the loop.
  action: z.enum(['none', 'ask_clarification', 'create_ticket']),
  question: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).nullable(),
});

export type TriageDecision = z.infer<typeof DecisionSchema>;

/** What a call cost, as the provider reports it. */
export interface TriageUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface TriageInput {
  messages: { displayName: string; body: string }[];
  instructions?: string | null;
  /**
   * Called once with the token counts when a request was actually dispatched —
   * including one that then failed, since a failed call is still billed.
   *
   * A callback rather than a second return value: every caller and every test
   * treats triage as "decision or null", and threading a tuple through would have
   * changed all of them to serve one caller that cares about cost.
   */
  onUsage?: (usage: TriageUsage) => void;
}

/** Every provider implements this and nothing more. */
export interface TriageProvider {
  readonly name: 'openai' | 'anthropic';
  isConfigured(): boolean;
  /** Returns null on any failure — chat must keep working without AI. */
  triage(input: TriageInput): Promise<TriageDecision | null>;
}

export const BASE_PROMPT = [
  'You triage an internal company support chat.',
  'Read the conversation and decide exactly one action.',
  'Choose "none" when there is nothing to do: small talk, greetings, acknowledgements such as',
  '"thanks" or "ok", or — most importantly — when an earlier message from you in this same',
  'conversation already says a ticket was filed. Never file a second ticket for a problem that',
  'has already been filed; prefer "none" whenever you are unsure.',
  'If a new report is too vague to act on, choose "ask_clarification" and write ONE specific question.',
  'If there is enough detail and no ticket exists yet for it, choose "create_ticket" with a short',
  'imperative title, a concise description summarising the problem, and a priority of low, medium,',
  'high, or urgent.',
  'Set every field you are not using to null.',
].join(' ');

/**
 * How much of the conversation the model reads. Exported because the automation
 * fetches exactly this many messages — two independent 20s meant a change to one
 * silently left the other fetching the wrong window.
 */
export const MAX_CONTEXT_MESSAGES = 20;
/** A pasted log or stack trace would otherwise send tens of thousands of tokens. */
const MAX_BODY_CHARS = 2000;

/** The system prompt, plus any per-channel steering an admin configured. */
export function systemPrompt(instructions?: string | null): string {
  return instructions ? `${BASE_PROMPT}\n\nExtra guidance: ${instructions}` : BASE_PROMPT;
}

/** The conversation as the model reads it: oldest first, most recent window only. */
export function transcriptOf(messages: TriageInput['messages']): string {
  return messages
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((m) => `${m.displayName}: ${m.body.slice(0, MAX_BODY_CHARS)}`)
    .join('\n');
}
