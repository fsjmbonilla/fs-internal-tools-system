import OpenAI from 'openai';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';

// gpt-5-nano is a reasoning model: it spends 700–1400 hidden reasoning tokens even on
// trivial prompts. Too low a cap and reasoning eats the whole budget, yielding HTTP 200
// with finish_reason 'length' and an EMPTY content string (verified against the live API).
const MAX_COMPLETION_TOKENS = 3000;
const MAX_CONTEXT_MESSAGES = 20;

const DecisionSchema = z.object({
  action: z.enum(['ask_clarification', 'create_ticket']),
  question: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).nullable(),
});

export type TriageDecision = z.infer<typeof DecisionSchema>;

const RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'triage',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['ask_clarification', 'create_ticket'] },
        question: { type: ['string', 'null'] },
        title: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
        priority: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'urgent', null] },
      },
      required: ['action', 'question', 'title', 'description', 'priority'],
    },
  },
};

const BASE_PROMPT = [
  'You triage an internal company support chat.',
  'Read the conversation and decide exactly one action.',
  'If the report is too vague to act on, choose "ask_clarification" and write ONE specific question.',
  'If there is enough detail, choose "create_ticket" with a short imperative title, a concise',
  'description summarising the problem, and a priority of low, medium, high, or urgent.',
  'Set every field you are not using to null.',
].join(' ');

let client: OpenAI | null | undefined;

function getClient(): OpenAI | null {
  if (client !== undefined) return client;
  client = config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;
  return client;
}

export function isAiConfigured(): boolean {
  return Boolean(config.OPENAI_API_KEY);
}

export async function triageSupportConversation(input: {
  messages: { displayName: string; body: string }[];
  instructions?: string | null;
}): Promise<TriageDecision | null> {
  const openai = getClient();
  if (!openai) return null;

  const system = input.instructions ? `${BASE_PROMPT}\n\nExtra guidance: ${input.instructions}` : BASE_PROMPT;
  const transcript = input.messages
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((m) => `${m.displayName}: ${m.body}`)
    .join('\n');

  try {
    const completion = await openai.chat.completions.create({
      model: config.AI_MODEL,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      response_format: RESPONSE_FORMAT,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: transcript },
      ],
    });

    const choice = completion.choices[0];
    const content = choice?.message?.content;
    if (!content) {
      // Empty content with finish_reason 'length' = reasoning exhausted the token budget.
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
}
