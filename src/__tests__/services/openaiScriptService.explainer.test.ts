jest.mock('../../config', () => ({
  config: {
    openaiApiKey: 'mock-openai-key',
  },
}));

import { FORMATS_BY_ID } from '../../config/formats';
import { expandExplainerScript } from '../../services/openaiScriptService';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const scriptTemplate = FORMATS_BY_ID.explainer!.script_template;
const baseArgs = {
  topic: 'volcanoes',
  sceneCount: 2,
  styleLabel: 'pixel art',
  scriptTemplate,
};

function responseWith(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function validScene(overrides: Record<string, unknown> = {}) {
  return {
    visual_prompt: 'a cutaway diagram of a volcano with a clean lower third',
    motion_prompt: 'gentle camera push-in',
    narration_line: 'Magma rises beneath the volcano.',
    text_zone: 'lower_third',
    segment_type: 'dialogue',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('expandExplainerScript', () => {
  it('returns validated scenes and truncates extras to the requested scene count', async () => {
    mockFetch.mockResolvedValue(responseWith(JSON.stringify({
      scenes: [validScene(), validScene(), validScene()],
      music_mood: 'dramatic',
    })));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes).toHaveLength(2);
    expect(result.scenes.every((scene) => scene.segment_type === 'dialogue')).toBe(true);
    expect(result.music_mood).toBe('dramatic');
  });

  it('returns a structural single-scene fallback for malformed JSON', async () => {
    mockFetch.mockResolvedValue(responseWith('not-json'));

    const result = await expandExplainerScript(baseArgs);

    expect(result).toEqual({
      scenes: [{
        visual_prompt: expect.stringContaining('volcanoes'),
        motion_prompt: expect.any(String),
        narration_line: 'volcanoes',
        text_zone: 'lower_third',
        segment_type: 'dialogue',
      }],
      music_mood: 'ambient',
    });
  });

  it('sends the registry prohibition against narrator and presenter figures', async () => {
    mockFetch.mockResolvedValue(responseWith(JSON.stringify({ scenes: [validScene()], music_mood: 'ambient' })));

    await expandExplainerScript(baseArgs);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    const systemPrompt = body.messages[0].content.toLowerCase();
    expect(systemPrompt).toContain('narrator');
    expect(systemPrompt).toContain('presenter');
  });

  it('defensively rewrites narrator-figure phrases in visual prompts', async () => {
    mockFetch.mockResolvedValue(responseWith(JSON.stringify({
      scenes: [validScene({ visual_prompt: 'A narrator explaining plate tectonics' })],
      music_mood: 'ambient',
    })));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.visual_prompt.toLowerCase()).not.toContain('narrator');
    expect(result.scenes[0]!.visual_prompt).toContain('the subject');
  });

  it('coerces disallowed segment types and invalid text zones', async () => {
    mockFetch.mockResolvedValue(responseWith(JSON.stringify({
      scenes: [validScene({ segment_type: 'vocab', text_zone: 'left' })],
      music_mood: 'unknown',
    })));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.segment_type).toBe('dialogue');
    expect(result.scenes[0]!.text_zone).toBe('lower_third');
    expect(result.music_mood).toBe('ambient');
  });

  it('includes factual grounding only when grounding text is present', async () => {
    mockFetch.mockResolvedValue(responseWith(JSON.stringify({ scenes: [validScene()], music_mood: 'ambient' })));

    await expandExplainerScript({
      ...baseArgs,
      groundingText: 'Mount St. Helens erupted in 1980.',
    });
    const groundedBody = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(groundedBody.messages[1].content).toContain('SOURCE MATERIAL');
    expect(groundedBody.messages[1].content).toContain('Mount St. Helens erupted in 1980.');

    mockFetch.mockClear();
    await expandExplainerScript(baseArgs);
    const ungroundedBody = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(ungroundedBody.messages[1].content).not.toContain('SOURCE MATERIAL');
  });
});
