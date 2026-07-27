// src/__tests__/services/promptIntelligenceService.test.ts
// Unit tests for enhancePrompt/promptFromImage — fail-loud contract (PromptIntelligenceError on
// any LLM failure, never a silent input echo), instruction override, vision message shape.

jest.mock('../../config', () => ({
  config: { openaiApiKey: 'test-openai-key' },
}));

import {
  enhancePrompt,
  promptFromImage,
  PromptIntelligenceError,
  DEFAULT_ENHANCE_PROMPT_INSTRUCTION,
  DEFAULT_ENHANCE_SCRIPT_INSTRUCTION,
  DEFAULT_FROM_IMAGE_INSTRUCTION,
  enhanceForDispatch,
  DISPATCH_CONTINUATION_INSTRUCTION,
  DISPATCH_FREEFORM_INSTRUCTION,
  DISPATCH_I2V_INSTRUCTION,
} from '../../services/promptIntelligenceService';

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function okCompletion(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function sentBody(): { model: string; messages: Array<{ role: string; content: unknown }> } {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('enhancePrompt', () => {
  it('returns the trimmed completion on success', async () => {
    fetchMock.mockResolvedValue(okCompletion('  A cinematic prompt.  '));
    await expect(enhancePrompt({ prompt: 'a dog' })).resolves.toBe('A cinematic prompt.');
  });

  it("uses the prompt default instruction for mode 'prompt' and script default for 'script'", async () => {
    fetchMock.mockResolvedValue(okCompletion('x'));
    await enhancePrompt({ prompt: 'a dog', mode: 'prompt' });
    expect(sentBody().messages[0]).toEqual({ role: 'system', content: DEFAULT_ENHANCE_PROMPT_INSTRUCTION });

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(okCompletion('x'));
    await enhancePrompt({ prompt: 'a dog', mode: 'script' });
    expect(sentBody().messages[0]).toEqual({ role: 'system', content: DEFAULT_ENHANCE_SCRIPT_INSTRUCTION });
  });

  it('a per-preset instruction overrides the mode default', async () => {
    fetchMock.mockResolvedValue(okCompletion('x'));
    await enhancePrompt({ prompt: 'a dog', mode: 'script', instruction: 'CUSTOM PRESET INSTRUCTION' });
    expect(sentBody().messages[0]).toEqual({ role: 'system', content: 'CUSTOM PRESET INSTRUCTION' });
  });

  it('throws PromptIntelligenceError on non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    await expect(enhancePrompt({ prompt: 'a dog' })).rejects.toBeInstanceOf(PromptIntelligenceError);
  });

  it('throws PromptIntelligenceError on empty completion', async () => {
    fetchMock.mockResolvedValue(okCompletion(''));
    await expect(enhancePrompt({ prompt: 'a dog' })).rejects.toBeInstanceOf(PromptIntelligenceError);
  });

  it('throws PromptIntelligenceError when fetch itself rejects', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(enhancePrompt({ prompt: 'a dog' })).rejects.toBeInstanceOf(PromptIntelligenceError);
  });
});

describe('promptFromImage', () => {
  it('sends a vision message with the image URL and default instruction', async () => {
    fetchMock.mockResolvedValue(okCompletion('An i2v prompt.'));
    const result = await promptFromImage({ imageUrl: 'https://r2.example.com/signed.jpg' });
    expect(result).toBe('An i2v prompt.');

    const body = sentBody();
    expect(body.messages[0]).toEqual({ role: 'system', content: DEFAULT_FROM_IMAGE_INSTRUCTION });
    const parts = body.messages[1].content as Array<Record<string, unknown>>;
    expect(parts).toEqual([
      { type: 'text', text: 'Write the prompt for this image.' },
      { type: 'image_url', image_url: { url: 'https://r2.example.com/signed.jpg' } },
    ]);
  });

  it('includes the user hint in the text part when provided', async () => {
    fetchMock.mockResolvedValue(okCompletion('x'));
    await promptFromImage({ imageUrl: 'https://r2.example.com/signed.jpg', hint: 'make it rainy' });
    const parts = sentBody().messages[1].content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({
      type: 'text',
      text: 'Write the prompt for this image. User direction: make it rainy',
    });
  });

  it('uses the per-preset instruction when provided', async () => {
    fetchMock.mockResolvedValue(okCompletion('x'));
    await promptFromImage({ imageUrl: 'https://r2.example.com/signed.jpg', instruction: 'OLD PHOTO INSTRUCTION' });
    expect(sentBody().messages[0]).toEqual({ role: 'system', content: 'OLD PHOTO INSTRUCTION' });
  });

  it('throws PromptIntelligenceError on non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(
      promptFromImage({ imageUrl: 'https://r2.example.com/signed.jpg' }),
    ).rejects.toBeInstanceOf(PromptIntelligenceError);
  });
});

// ─── enhanceForDispatch (in-pipeline interceptor, 2026-07-25) ──────────────────
// Fail-OPEN contract (the mirror image of the suggest endpoints): any LLM failure, empty
// completion, or timeout must resolve null — never throw, never block a paid dispatch.
describe('enhanceForDispatch', () => {
  it('returns the trimmed completion on success', async () => {
    fetchMock.mockResolvedValue(okCompletion('  Enhanced prompt.  '));
    await expect(
      enhanceForDispatch({ prompt: 'a dog', hasReferenceVideos: false, hasReferenceImages: false }),
    ).resolves.toBe('Enhanced prompt.');
  });

  it('picks the continuation instruction when a reference video is present', async () => {
    fetchMock.mockResolvedValue(okCompletion('x'));
    await enhanceForDispatch({ prompt: 'keep going', hasReferenceVideos: true, hasReferenceImages: false });
    expect(sentBody().messages[0]).toEqual({ role: 'system', content: DISPATCH_CONTINUATION_INSTRUCTION });
  });

  it('picks the i2v instruction when only reference images are present', async () => {
    fetchMock.mockResolvedValue(okCompletion('x'));
    await enhanceForDispatch({ prompt: 'make it move', hasReferenceVideos: false, hasReferenceImages: true });
    expect(sentBody().messages[0]).toEqual({ role: 'system', content: DISPATCH_I2V_INSTRUCTION });
  });

  it('prefers continuation over i2v when both reference kinds are present', async () => {
    fetchMock.mockResolvedValue(okCompletion('x'));
    await enhanceForDispatch({ prompt: 'keep going', hasReferenceVideos: true, hasReferenceImages: true });
    expect(sentBody().messages[0]).toEqual({ role: 'system', content: DISPATCH_CONTINUATION_INSTRUCTION });
  });

  it('uses the self-gating polish instruction for plain t2v', async () => {
    fetchMock.mockResolvedValue(okCompletion('x'));
    await enhanceForDispatch({ prompt: 'a dog', hasReferenceVideos: false, hasReferenceImages: false });
    expect(sentBody().messages[0]).toEqual({ role: 'system', content: DISPATCH_FREEFORM_INSTRUCTION });
  });

  it('sends the interceptor request shape (gpt-5-mini, minimal effort, capped tokens)', async () => {
    fetchMock.mockResolvedValue(okCompletion('x'));
    await enhanceForDispatch({ prompt: 'a dog', hasReferenceVideos: false, hasReferenceImages: false });
    const body = sentBody() as unknown as Record<string, unknown>;
    expect(body.model).toBe('gpt-5-mini');
    expect(body.reasoning_effort).toBe('minimal');
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it('resolves null (never throws) on non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(
      enhanceForDispatch({ prompt: 'a dog', hasReferenceVideos: false, hasReferenceImages: false }),
    ).resolves.toBeNull();
  });

  it('resolves null (never throws) on network error', async () => {
    fetchMock.mockRejectedValue(new Error('socket hangup'));
    await expect(
      enhanceForDispatch({ prompt: 'a dog', hasReferenceVideos: false, hasReferenceImages: false }),
    ).resolves.toBeNull();
  });

  it('resolves null on empty completion', async () => {
    fetchMock.mockResolvedValue(okCompletion('   '));
    await expect(
      enhanceForDispatch({ prompt: 'a dog', hasReferenceVideos: false, hasReferenceImages: false }),
    ).resolves.toBeNull();
  });

  it('strips brackets from tokens the LLM invented, keeping the words', async () => {
    fetchMock.mockResolvedValue(okCompletion('A low-angle close-up of [a guy] carving a wave, camera tracking.'));
    await expect(
      enhanceForDispatch({ prompt: 'a guy surfing', hasReferenceVideos: false, hasReferenceImages: false }),
    ).resolves.toBe('A low-angle close-up of a guy carving a wave, camera tracking.');
  });

  it('preserves user-written bracket tokens exactly', async () => {
    fetchMock.mockResolvedValue(okCompletion('Continue [video1] with [my dog] running alongside.'));
    await expect(
      enhanceForDispatch({ prompt: 'continue [video1] with [my dog]', hasReferenceVideos: true, hasReferenceImages: false }),
    ).resolves.toBe('Continue [video1] with [my dog] running alongside.');
  });
});
