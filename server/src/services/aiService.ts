import { activeProvider } from './ai/index.js';
import type { TriageDecision, TriageInput } from './ai/triage.js';

/**
 * AI triage, provider-agnostic.
 *
 * Callers only ever needed "decide what to do with this conversation", so that is
 * all this exposes. Which backend answers is a configuration question —
 * AI_PROVIDER, openai or anthropic — and the prompt and decision schema are
 * shared between them, so switching changes how the request is made rather than
 * what is being decided.
 *
 * The implementations live in ./ai: triage.ts holds the shared contract,
 * openaiProvider.ts and anthropicProvider.ts hold one backend each.
 */

export type { TriageDecision } from './ai/triage.js';

export function isAiConfigured(): boolean {
  return activeProvider().isConfigured();
}

/** Which provider is in use — for diagnostics and logs. */
export function aiProviderName(): string {
  return activeProvider().name;
}

/**
 * Returns null whenever no decision could be reached: unconfigured, refused,
 * schema mismatch, or an API failure. Every caller treats null as "do nothing",
 * which is what keeps chat working when the AI does not.
 */
export async function triageSupportConversation(
  input: TriageInput,
): Promise<TriageDecision | null> {
  return activeProvider().triage(input);
}
