import OpenAI from 'openai';
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

let client: OpenAI | null | undefined;

function getClient(): OpenAI | null {
  if (client !== undefined) return client;
  client = config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;
  return client;
}

export const openaiProvider: TriageProvider = {
  name: 'openai',

  isConfigured(): boolean {
    return Boolean(config.OPENAI_API_KEY);
  },

  async triage(input: TriageInput): Promise<TriageDecision | null> {
    const openai = getClient();
    if (!openai) return null;

    try {
      const completion = await openai.chat.completions.create({
        model: config.AI_MODEL || DEFAULT_MODEL,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        response_format: RESPONSE_FORMAT,
        messages: [
          { role: 'system', content: systemPrompt(input.instructions) },
          { role: 'user', content: transcriptOf(input.messages) },
        ],
      });

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
      logger.error({ err }, 'AI triage failed');
      return null;
    }
  },
};

export const OPENAI_DEFAULT_MODEL = DEFAULT_MODEL;
