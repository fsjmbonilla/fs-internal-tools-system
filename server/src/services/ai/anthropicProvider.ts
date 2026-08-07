import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { logger } from '../../logger.js';
import { getAiConfig, getSecret } from '../integrationsCache.js';
import {
  DecisionSchema,
  systemPrompt,
  transcriptOf,
  type CompletionInput,
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

let client: Anthropic | null = null;
let clientApiKey: string | undefined;

/**
 * Same shape as the OpenAI provider: the key resolves at call time (admin-set
 * value, else ANTHROPIC_API_KEY) and the client is memoized per key, so a
 * runtime key change takes effect on the next call.
 */
function getClient(): Anthropic | null {
  const apiKey = getSecret('anthropic_api_key');
  if (!apiKey) {
    client = null;
    clientApiKey = undefined;
    return null;
  }
  if (!client || clientApiKey !== apiKey) {
    client = new Anthropic({ apiKey });
    clientApiKey = apiKey;
  }
  return client;
}

export const anthropicProvider: TriageProvider = {
  name: 'anthropic',

  isConfigured(): boolean {
    return Boolean(getSecret('anthropic_api_key'));
  },

  async triage(input: TriageInput): Promise<TriageDecision | null> {
    const anthropic = getClient();
    if (!anthropic) return null;

    const model = getAiConfig().model || DEFAULT_MODEL;
    // Same contract as the OpenAI provider: report a dispatched call exactly once,
    // whatever it returns, because it is billable either way.
    let reported = false;
    const report = (promptTokens = 0, completionTokens = 0) => {
      if (reported) return;
      reported = true;
      input.onUsage?.({ provider: 'anthropic', model, promptTokens, completionTokens });
    };

    try {
      // messages.parse() validates the response against the schema for us, so a
      // reply that does not fit the contract surfaces here rather than deeper in
      // the automation.
      const response = await anthropic.messages.parse({
        model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt(input.instructions),
        output_config: {
          format: zodOutputFormat(DecisionSchema),
          // Triage is a classification, not deep reasoning.
          effort: 'low',
        },
        messages: [{ role: 'user', content: transcriptOf(input.messages) }],
      });

      report(response.usage?.input_tokens, response.usage?.output_tokens);

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
      report();
      logger.error({ err }, 'AI triage failed');
      return null;
    }
  },

  async complete(input: CompletionInput): Promise<string> {
    const anthropic = getClient();
    if (!anthropic) throw new Error('ANTHROPIC_API_KEY is not configured');

    const model = getAiConfig().model || DEFAULT_MODEL;
    // Same contract as triage: report a dispatched call exactly once, whatever
    // it returns, because it is billable either way.
    let reported = false;
    const report = (promptTokens = 0, completionTokens = 0) => {
      if (reported) return;
      reported = true;
      input.onUsage?.({ provider: 'anthropic', model, promptTokens, completionTokens });
    };

    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: input.maxTokens,
        system: input.system,
        messages: [{ role: 'user', content: input.prompt }],
      });
      report(response.usage?.input_tokens, response.usage?.output_tokens);
      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim();
      if (!text) throw new Error('The AI returned an empty reply');
      return text;
    } catch (err) {
      // Unlike triage this throws — but the attempt is recorded first.
      report();
      throw err;
    }
  },
};

export const ANTHROPIC_DEFAULT_MODEL = DEFAULT_MODEL;
