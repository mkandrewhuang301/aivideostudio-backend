// src/__tests__/services/openaiScriptService.test.ts
// Wave 0 scaffold (09.3-01) — SC3: LLM script-expansion fail-open contract for the gorilla
// vlogger (CONTEXT.md D-05, RESEARCH.md #5). RED until a later wave builds
// src/services/openaiScriptService.ts (new file — no existing text-completion OpenAI helper;
// only openaiImageService.ts and promptModeration.ts call OpenAI today).
//
// Mirrors the fail-open pattern in promptModeration.ts's checkOpenAIModeration: an LLM outage
// or non-OK response must fall back to a templated prompt, never hard-fail the whole generation
// (CLAUDE.md-adjacent correctness requirement — a transient LLM outage must not block the vlog).

jest.mock('../../config', () => ({
  config: {
    openaiApiKey: 'mock-openai-key',
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// NOT YET BUILT — RED until implementation.
import { expandScript } from '../../services/openaiScriptService';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('expandScript', () => {
  it('returns the LLM-expanded dialogue prompt on a successful OpenAI call', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Gorilla says: hello world' } }] }),
    });

    const result = await expandScript({ userScript: 'hello world', dialogueTemplate: 'Gorilla says: {script}' });

    expect(typeof result).toBe('string');
    expect(result).toContain('hello world');
  });

  it('falls back to the templated prompt (no throw) when the OpenAI call rejects', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    const result = await expandScript({ userScript: 'hello', dialogueTemplate: 'Gorilla says: {script}' });

    expect(typeof result).toBe('string');
    expect(result).toContain('hello');
  });

  it('falls back to the templated prompt (no throw) when OpenAI returns a non-OK response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });

    const result = await expandScript({ userScript: 'hello', dialogueTemplate: 'Gorilla says: {script}' });

    expect(typeof result).toBe('string');
    expect(result).toContain('hello');
  });
});
