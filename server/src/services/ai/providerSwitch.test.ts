/**
 * The provider switch, and the Claude provider's failure handling.
 *
 * The property worth protecting is that switching backends changes how the
 * request is made, not what is decided: the prompt and the decision schema come
 * from triage.ts, so both providers are held to the same contract.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const openaiCreate = vi.hoisted(() => vi.fn());
const anthropicParse = vi.hoisted(() => vi.fn());
const providerConfig = vi.hoisted(() => ({
  AI_PROVIDER: 'openai' as 'openai' | 'anthropic',
  OPENAI_API_KEY: 'sk-test',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  AI_MODEL: '',
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { parse: anthropicParse };
  },
}));

vi.mock('../../config.js', () => ({ config: providerConfig }));

const { triageSupportConversation, isAiConfigured, aiProviderName } = await import(
  '../aiService.js'
);
const { BASE_PROMPT } = await import('./triage.js');
const { OPENAI_DEFAULT_MODEL } = await import('./openaiProvider.js');
const { ANTHROPIC_DEFAULT_MODEL } = await import('./anthropicProvider.js');

const DECISION = {
  action: 'create_ticket',
  question: null,
  title: 'Fix the AC leak',
  description: 'Water on the floor in Meeting Room B',
  priority: 'high',
};

const CONVERSATION = {
  messages: [{ displayName: 'Ana', body: 'The AC is leaking onto the floor.' }],
  instructions: null,
};

afterEach(() => {
  openaiCreate.mockReset();
  anthropicParse.mockReset();
  providerConfig.AI_PROVIDER = 'openai';
  providerConfig.AI_MODEL = '';
});

describe('provider selection', () => {
  it('uses OpenAI by default', async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(DECISION) }, finish_reason: 'stop' }],
    });

    expect(aiProviderName()).toBe('openai');
    await expect(triageSupportConversation(CONVERSATION)).resolves.toMatchObject({
      action: 'create_ticket',
    });
    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(anthropicParse).not.toHaveBeenCalled();
  });

  it('routes to Claude when AI_PROVIDER says so', async () => {
    providerConfig.AI_PROVIDER = 'anthropic';
    anthropicParse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: DECISION });

    expect(aiProviderName()).toBe('anthropic');
    await expect(triageSupportConversation(CONVERSATION)).resolves.toMatchObject({
      action: 'create_ticket',
    });
    expect(anthropicParse).toHaveBeenCalledTimes(1);
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('gives both providers the same prompt and the same transcript', async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(DECISION) }, finish_reason: 'stop' }],
    });
    await triageSupportConversation(CONVERSATION);

    providerConfig.AI_PROVIDER = 'anthropic';
    anthropicParse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: DECISION });
    await triageSupportConversation(CONVERSATION);

    const [openaiReq] = openaiCreate.mock.calls[0];
    const [anthropicReq] = anthropicParse.mock.calls[0];

    // OpenAI carries the system prompt as a message; Anthropic as a top-level
    // field. Same text either way — that is the point of sharing triage.ts.
    const openaiSystem = openaiReq.messages.find(
      (m: { role: string }) => m.role === 'system',
    ).content;
    expect(openaiSystem).toBe(BASE_PROMPT);
    expect(anthropicReq.system).toBe(BASE_PROMPT);

    const transcript = 'Ana: The AC is leaking onto the floor.';
    expect(openaiReq.messages.at(-1).content).toBe(transcript);
    expect(anthropicReq.messages.at(-1).content).toBe(transcript);
  });

  it("falls back to each provider's own default model", async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(DECISION) }, finish_reason: 'stop' }],
    });
    await triageSupportConversation(CONVERSATION);
    expect(openaiCreate.mock.calls[0][0].model).toBe(OPENAI_DEFAULT_MODEL);

    providerConfig.AI_PROVIDER = 'anthropic';
    anthropicParse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: DECISION });
    await triageSupportConversation(CONVERSATION);
    expect(anthropicParse.mock.calls[0][0].model).toBe(ANTHROPIC_DEFAULT_MODEL);
  });

  it('does not use a reasoning model by default on OpenAI', async () => {
    // gpt-5-nano answered identically while spending 16x the output tokens and
    // 4x the latency, and returns empty content when reasoning eats the budget.
    expect(OPENAI_DEFAULT_MODEL).not.toMatch(/gpt-5.*nano|^o[0-9]/);
  });

  it('honours an explicit AI_MODEL', async () => {
    providerConfig.AI_MODEL = 'gpt-4o-mini';
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(DECISION) }, finish_reason: 'stop' }],
    });
    await triageSupportConversation(CONVERSATION);
    expect(openaiCreate.mock.calls[0][0].model).toBe('gpt-4o-mini');
  });

  it('reports configured per provider', async () => {
    expect(isAiConfigured()).toBe(true);
    providerConfig.AI_PROVIDER = 'anthropic';
    expect(isAiConfigured()).toBe(true);

    providerConfig.ANTHROPIC_API_KEY = '';
    expect(isAiConfigured()).toBe(false);
    providerConfig.ANTHROPIC_API_KEY = 'sk-ant-test';
  });
});

describe('the Claude provider decides nothing rather than guessing', () => {
  it('treats a refusal as no decision', async () => {
    providerConfig.AI_PROVIDER = 'anthropic';
    // Safety classifiers decline with HTTP 200 and no usable content; reading
    // content blindly here would be the bug.
    anthropicParse.mockResolvedValue({
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      parsed_output: null,
    });
    await expect(triageSupportConversation(CONVERSATION)).resolves.toBeNull();
  });

  it('treats a truncated answer as no decision', async () => {
    providerConfig.AI_PROVIDER = 'anthropic';
    anthropicParse.mockResolvedValue({ stop_reason: 'max_tokens', parsed_output: null });
    await expect(triageSupportConversation(CONVERSATION)).resolves.toBeNull();
  });

  it('treats a schema mismatch as no decision', async () => {
    providerConfig.AI_PROVIDER = 'anthropic';
    anthropicParse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: null });
    await expect(triageSupportConversation(CONVERSATION)).resolves.toBeNull();
  });

  it('fails soft on an API error, so chat keeps working', async () => {
    providerConfig.AI_PROVIDER = 'anthropic';
    anthropicParse.mockRejectedValue(new Error('overloaded'));
    await expect(triageSupportConversation(CONVERSATION)).resolves.toBeNull();
  });
});
