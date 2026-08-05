/**
 * The terminal action — Phase 7 CRITICAL 1.
 *
 * The triage schema originally offered only 'ask_clarification' and
 * 'create_ticket', so every human message in a support channel forced one of
 * them. Nothing recorded that a ticket had already been filed, so a bare
 * "thanks!" re-triaged the whole transcript and filed a duplicate — and each
 * further message forced another paid autonomous action. The bot-guard prevented
 * bot-to-bot recursion; it did nothing about this.
 */

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

const { triageSupportConversation } = await import('./aiService.js');

function reply(content: string) {
  return { choices: [{ message: { content }, finish_reason: 'stop' }] };
}

const nothingToDo = JSON.stringify({
  action: 'none',
  question: null,
  title: null,
  description: null,
  priority: null,
});

describe('triage can decide to do nothing', () => {
  afterEach(() => create.mockReset());

  it("accepts 'none' as a decision", async () => {
    create.mockResolvedValue(reply(nothingToDo));
    const decision = await triageSupportConversation({
      messages: [{ displayName: 'Ann', body: 'thanks!' }],
      instructions: null,
    });
    expect(decision?.action).toBe('none');
  });

  it("offers 'none' to the model, not just to the parser", async () => {
    // If the enum the API is held to omits 'none', the model can never return it
    // however the prompt is worded — so assert the request itself.
    create.mockResolvedValue(reply(nothingToDo));
    await triageSupportConversation({
      messages: [{ displayName: 'Ann', body: 'ok' }],
      instructions: null,
    });

    const [request] = create.mock.calls[0];
    const actionSchema = request.response_format.json_schema.schema.properties.action;
    expect(actionSchema.enum).toContain('none');
    expect(actionSchema.enum).toEqual(
      expect.arrayContaining(['none', 'ask_clarification', 'create_ticket']),
    );
  });

  it('tells the model not to file a second ticket for something already filed', async () => {
    create.mockResolvedValue(reply(nothingToDo));
    await triageSupportConversation({
      messages: [{ displayName: 'FS Assistant', body: 'Filed ticket #7: Fix the AC leak' }],
      instructions: null,
    });

    const [request] = create.mock.calls[0];
    const system = request.messages.find((m: { role: string }) => m.role === 'system').content;
    expect(system).toMatch(/already/i);
    expect(system).toMatch(/never file a second ticket/i);
  });
});
