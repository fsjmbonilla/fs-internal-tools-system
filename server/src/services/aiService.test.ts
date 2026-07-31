import { afterEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

vi.mock('../config.js', () => ({
  config: { OPENAI_API_KEY: 'sk-test', AI_MODEL: 'gpt-5-nano' },
}));

const { isAiConfigured, triageSupportConversation } = await import('./aiService.js');

function reply(content: string, finishReason = 'stop') {
  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

describe('aiService (configured)', () => {
  // NOTE: reset in afterEach, not beforeEach. See "Discrepancy from brief" in
  // task-3-report.md — a confirmed Vitest v4 regression (vitest-dev/vitest#10845)
  // makes `beforeEach(() => create.mockReset())` immediately before a test that
  // awaits a rejected mock inside try/catch spuriously fail that test, even though
  // the rejection is genuinely caught (verified independently of aiService.ts).
  // afterEach gives the same per-test isolation without triggering the bug.
  afterEach(() => create.mockReset());

  it('reports configured', () => {
    expect(isAiConfigured()).toBe(true);
  });

  it('parses a create_ticket decision', async () => {
    create.mockResolvedValue(
      reply(
        JSON.stringify({
          action: 'create_ticket',
          question: null,
          title: 'Printer jammed',
          description: 'Floor 2 printer is jammed.',
          priority: 'high',
        }),
      ),
    );

    const decision = await triageSupportConversation({
      messages: [{ displayName: 'jane', body: 'printer jammed' }],
    });

    expect(decision).toEqual({
      action: 'create_ticket',
      question: null,
      title: 'Printer jammed',
      description: 'Floor 2 printer is jammed.',
      priority: 'high',
    });
  });

  it('parses an ask_clarification decision', async () => {
    create.mockResolvedValue(
      reply(
        JSON.stringify({
          action: 'ask_clarification',
          question: 'Which printer?',
          title: null,
          description: null,
          priority: null,
        }),
      ),
    );
    const decision = await triageSupportConversation({ messages: [{ displayName: 'j', body: 'broken' }] });
    expect(decision?.action).toBe('ask_clarification');
    expect(decision?.question).toBe('Which printer?');
  });

  it('passes per-channel instructions into the system prompt', async () => {
    create.mockResolvedValue(
      reply(JSON.stringify({ action: 'ask_clarification', question: 'q', title: null, description: null, priority: null })),
    );
    await triageSupportConversation({
      messages: [{ displayName: 'j', body: 'hi' }],
      instructions: 'Always ask for the store branch.',
    });
    const systemContent = create.mock.calls[0][0].messages[0].content as string;
    expect(systemContent).toContain('Always ask for the store branch.');
  });

  // The verified real-world failure mode: gpt-5-nano is a reasoning model, and when the
  // token budget is exhausted the API returns 200 with finish_reason 'length' and an
  // EMPTY content string. A naive JSON.parse would throw a misleading syntax error.
  it('returns null when the response was truncated to empty by reasoning-token exhaustion', async () => {
    create.mockResolvedValue(reply('', 'length'));
    expect(await triageSupportConversation({ messages: [{ displayName: 'j', body: 'hi' }] })).toBeNull();
  });

  it('returns null on malformed JSON rather than throwing', async () => {
    create.mockResolvedValue(reply('not json at all'));
    expect(await triageSupportConversation({ messages: [{ displayName: 'j', body: 'hi' }] })).toBeNull();
  });

  it('returns null when the decision fails schema validation', async () => {
    create.mockResolvedValue(reply(JSON.stringify({ action: 'explode', question: null })));
    expect(await triageSupportConversation({ messages: [{ displayName: 'j', body: 'hi' }] })).toBeNull();
  });

  it('returns null when the API call throws, never propagating the error', async () => {
    create.mockRejectedValue(new Error('502 upstream'));
    expect(await triageSupportConversation({ messages: [{ displayName: 'j', body: 'hi' }] })).toBeNull();
  });
});
