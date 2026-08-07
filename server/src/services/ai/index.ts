import { getAiConfig } from '../integrationsCache.js';
import { anthropicProvider } from './anthropicProvider.js';
import { openaiProvider } from './openaiProvider.js';
import type { TriageProvider } from './triage.js';

const PROVIDERS: Record<'openai' | 'anthropic', TriageProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

/**
 * The selected provider: the admin-set integrations value if there is one,
 * else AI_PROVIDER. Resolved per call so a runtime change (or a test varying
 * the config) takes effect on the next call.
 */
export function activeProvider(): TriageProvider {
  return PROVIDERS[getAiConfig().provider] ?? openaiProvider;
}

export { ANTHROPIC_DEFAULT_MODEL } from './anthropicProvider.js';
export { OPENAI_DEFAULT_MODEL } from './openaiProvider.js';
export type { TriageDecision, TriageInput, TriageProvider } from './triage.js';
