import { describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } };
  },
}));
vi.mock('../config.js', () => ({ config: { OPENAI_API_KEY: undefined, AI_MODEL: 'gpt-5-nano' } }));

const { isAiConfigured, triageSupportConversation } = await import('./aiService.js');

describe('aiService (unconfigured)', () => {
  it('reports not configured and never calls the API', async () => {
    expect(isAiConfigured()).toBe(false);
    expect(await triageSupportConversation({ messages: [{ displayName: 'j', body: 'hi' }] })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
