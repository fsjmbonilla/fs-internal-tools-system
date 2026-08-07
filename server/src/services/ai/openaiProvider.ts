import OpenAI from 'openai';
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
 * OpenAI triage. The default provider.
 *
 * Model choice matters more than it looks. This ran on gpt-5-nano, a reasoning
 * model that spends hidden reasoning tokens even on trivial prompts: measured
 * against the three decisions that matter, it answered identically to four
 * non-reasoning models while using 654 output tokens (597 of them reasoning) and
 * 5.5s, versus ~41 tokens and ~1.5s. It also has a failure mode the cheaper
 * models do not — when reasoning eats the whole budget the API returns HTTP 200
 * with finish_reason 'length' and an EMPTY content string, so triage silently
 * does nothing.
 */
const DEFAULT_MODEL = 'gpt-4.1-mini';

/** Generous, because an empty response is the failure mode being avoided. */
const MAX_COMPLETION_TOKENS = 3000;

const RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'triage',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['none', 'ask_clarification', 'create_ticket'] },
        question: { type: ['string', 'null'] },
        title: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
        priority: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'urgent', null] },
      },
      required: ['action', 'question', 'title', 'description', 'priority'],
    },
  },
};

let client: OpenAI | null = null;
let clientApiKey: string | undefined;

/**
 * The key resolves at call time (admin-set value, else OPENAI_API_KEY) and the
 * memoized client is keyed by it, so an admin saving a new key on the
 * Integrations tab takes effect on the next call without a restart.
 */
function getClient(): OpenAI | null {
  const apiKey = getSecret('openai_api_key');
  if (!apiKey) {
    client = null;
    clientApiKey = undefined;
    return null;
  }
  if (!client || clientApiKey !== apiKey) {
    client = new OpenAI({ apiKey });
    clientApiKey = apiKey;
  }
  return client;
}

export const openaiProvider: TriageProvider = {
  name: 'openai',

  isConfigured(): boolean {
    return Boolean(getSecret('openai_api_key'));
  },

  async triage(input: TriageInput): Promise<TriageDecision | null> {
    const openai = getClient();
    if (!openai) return null;

    const model = getAiConfig().model || DEFAULT_MODEL;
    // Report the attempt even if the call throws below: it was dispatched, so it
    // is billable and it must consume the channel's interval.
    let reported = false;
    const report = (promptTokens = 0, completionTokens = 0) => {
      if (reported) return;
      reported = true;
      input.onUsage?.({ provider: 'openai', model, promptTokens, completionTokens });
    };

    try {
      const completion = await openai.chat.completions.create({
        model,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        response_format: RESPONSE_FORMAT,
        messages: [
          { role: 'system', content: systemPrompt(input.instructions) },
          { role: 'user', content: transcriptOf(input.messages) },
        ],
      });

      report(completion.usage?.prompt_tokens, completion.usage?.completion_tokens);

      const choice = completion.choices[0];
      const content = choice?.message?.content;
      if (!content) {
        logger.warn({ finishReason: choice?.finish_reason }, 'AI triage returned no content');
        return null;
      }

      const parsed = DecisionSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues }, 'AI triage response failed schema validation');
        return null;
      }
      return parsed.data;
    } catch (err) {
      // Fail-soft on everything (network, 4xx/5xx, malformed JSON): chat must never break.
      report();
      logger.error({ err }, 'AI triage failed');
      return null;
    }
  },

  async complete(input: CompletionInput): Promise<string> {
    const openai = getClient();
    if (!openai) throw new Error('OPENAI_API_KEY is not configured');

    const model = getAiConfig().model || DEFAULT_MODEL;
    // Same contract as triage: report a dispatched call exactly once, whatever
    // it returns, because it is billable either way.
    let reported = false;
    const report = (promptTokens = 0, completionTokens = 0) => {
      if (reported) return;
      reported = true;
      input.onUsage?.({ provider: 'openai', model, promptTokens, completionTokens });
    };

    try {
      const completion = await openai.chat.completions.create({
        model,
        max_completion_tokens: input.maxTokens,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.prompt },
        ],
      });
      report(completion.usage?.prompt_tokens, completion.usage?.completion_tokens);
      const content = completion.choices[0]?.message?.content?.trim();
      if (!content) throw new Error('The AI returned an empty reply');
      return content;
    } catch (err) {
      // Unlike triage this throws — but the attempt is recorded first.
      report();
      throw err;
    }
  },
};

export const OPENAI_DEFAULT_MODEL = DEFAULT_MODEL;
