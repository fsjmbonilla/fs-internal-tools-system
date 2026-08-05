import { config } from '../../config.js';
import { anthropicProvider } from './anthropicProvider.js';
import { openaiProvider } from './openaiProvider.js';
import type { TriageProvider } from './triage.js';

const PROVIDERS: Record<'openai' | 'anthropic', TriageProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

/** The provider AI_PROVIDER selects. Resolved per call so tests can vary it. */
export function activeProvider(): TriageProvider {
  return PROVIDERS[config.AI_PROVIDER] ?? openaiProvider;
}

export { ANTHROPIC_DEFAULT_MODEL } from './anthropicProvider.js';
export { OPENAI_DEFAULT_MODEL } from './openaiProvider.js';
export type { TriageDecision, TriageInput, TriageProvider } from './triage.js';
