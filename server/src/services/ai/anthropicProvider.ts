import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import {
  DecisionSchema,
  systemPrompt,
  transcriptOf,
  type TriageDecision,
  type TriageInput,
  type TriageProvider,
} from './triage.js';

/**
 * Claude triage. Switch to it with AI_PROVIDER=anthropic.
 *
 * Kept in its own module rather than branching inside the OpenAI provider: the
 * two SDKs express structured output differently enough that one function
 * handling both would be mostly branches. The prompt and schema are shared, so
 * switching providers changes how the request is made and not what is decided.
 */
const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Thinking is on by default on Claude Opus 5 and max_tokens caps thinking plus
 * response text together, so this is sized for both. Effort 'low' is the lever
 * for cost here rather than disabling thinking, which has its own failure modes.
 */
const MAX_TOKENS = 8192;

let client: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (client !== undefined) return client;
  client = config.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }) : null;
  return client;
}

export const anthropicProvider: TriageProvider = {
  name: 'anthropic',

  isConfigured(): boolean {
    return Boolean(config.ANTHROPIC_API_KEY);
  },

  async triage(input: TriageInput): Promise<TriageDecision | null> {
    const anthropic = getClient();
    if (!anthropic) return null;

    try {
      // messages.parse() validates the response against the schema for us, so a
      // reply that does not fit the contract surfaces here rather than deeper in
      // the automation.
      const response = await anthropic.messages.parse({
        model: config.AI_MODEL || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt(input.instructions),
        output_config: {
          format: zodOutputFormat(DecisionSchema),
          // Triage is a classification, not deep reasoning.
          effort: 'low',
        },
        messages: [{ role: 'user', content: transcriptOf(input.messages) }],
      });

      // Safety classifiers can decline a request: HTTP 200 with no usable
      // content. Treat it as "no decision" rather than reading content blindly.
      if (response.stop_reason === 'refusal') {
        logger.warn({ stopDetails: response.stop_details }, 'AI triage refused');
        return null;
      }
      if (response.stop_reason === 'max_tokens') {
        logger.warn('AI triage hit max_tokens before completing its answer');
        return null;
      }

      // parsed_output is null when parsing failed.
      const decision = response.parsed_output;
      if (!decision) {
        logger.warn('AI triage response failed schema validation');
        return null;
      }
      return decision;
    } catch (err) {
      // Fail-soft, exactly as the OpenAI provider does: chat must never break.
      logger.error({ err }, 'AI triage failed');
      return null;
    }
  },
};

export const ANTHROPIC_DEFAULT_MODEL = DEFAULT_MODEL;
