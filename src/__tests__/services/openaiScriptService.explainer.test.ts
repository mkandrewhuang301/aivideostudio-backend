jest.mock('../../config', () => ({
  config: {
    openaiApiKey: 'mock-openai-key',
  },
}));

jest.mock('../../services/providers/ReplicateProvider', () => ({
  generateClaudeText: jest.fn(),
}));

import { FORMATS_BY_ID } from '../../config/formats';
import { expandExplainerScript } from '../../services/openaiScriptService';
import { generateClaudeText } from '../../services/providers/ReplicateProvider';

const mockGenerateClaudeText = generateClaudeText as jest.Mock;

const scriptTemplate = FORMATS_BY_ID.explainer!.script_template;
const baseArgs = {
  topic: 'volcanoes',
  sceneCount: 2,
  styleLabel: 'pixel art',
  scriptTemplate,
};

function validScene(overrides: Record<string, unknown> = {}) {
  return {
    narration_segment: 'Magma rises beneath the volcano.',
    visual_prompt: 'a cutaway diagram of a volcano with a clean lower third',
    motion_prompt: 'gentle camera push-in',
    text_zone: 'lower_third',
    segment_type: 'dialogue',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('expandExplainerScript', () => {
  it('returns validated scenes and clamps only a runaway scene count (count is emergent, not dictated)', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      full_script: 'Magma rises beneath the volcano.',
      scenes: [validScene(), validScene(), validScene()],
      music_mood: 'dramatic',
    }));

    const result = await expandExplainerScript(baseArgs);

    // sceneCount=2 is an ESTIMATE — 3 scenes is inside the 1.75x sanity band, so all are kept.
    expect(result.scenes).toHaveLength(3);
    expect(result.scenes.every((scene) => scene.segment_type === 'dialogue')).toBe(true);
    expect(result.music_mood).toBe('dramatic');
  });

  it('clamps a runaway scene count to the sanity band', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      full_script: 'Magma rises beneath the volcano.',
      scenes: Array.from({ length: 20 }, () => validScene()),
      music_mood: 'dramatic',
    }));

    const result = await expandExplainerScript(baseArgs);

    // sceneCount=2 -> maxScenes = max(4, ceil(2*1.75)) = 4
    expect(result.scenes).toHaveLength(4);
  });

  it('keeps verbatim segments that re-join to full_script', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      full_script: 'Magma rises beneath the volcano. Pressure builds until it erupts.',
      scenes: [
        validScene({ narration_segment: 'Magma rises beneath the volcano.' }),
        validScene({ narration_segment: 'Pressure builds until it erupts.' }),
      ],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.narration_line).toBe('Magma rises beneath the volcano.');
    expect(result.scenes[1]!.narration_line).toBe('Pressure builds until it erupts.');
    expect(result.full_script).toBe('Magma rises beneath the volcano. Pressure builds until it erupts.');
  });

  it('re-flows an authoritative full_script across scenes when the segments drift', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      full_script: 'Magma rises beneath the volcano. Pressure builds underground. The volcano erupts violently. Ash covers everything nearby.',
      scenes: [
        validScene({ narration_segment: 'The volcano gets angry.' }), // paraphrase, not a verbatim slice
        validScene({ narration_segment: 'It explodes.' }),
      ],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);

    // Segments dropped; full_script re-flowed over the two scenes, visuals/motion preserved.
    expect(result.scenes).toHaveLength(2);
    expect(result.scenes[0]!.narration_line).toContain('Magma rises');
    expect(result.scenes[1]!.narration_line).toContain('Ash covers everything nearby.');
    expect(result.scenes.map((s) => s.narration_line).join(' ')).toBe(
      'Magma rises beneath the volcano. Pressure builds underground. The volcano erupts violently. Ash covers everything nearby.',
    );
    expect(result.scenes[0]!.visual_prompt).toContain('cutaway diagram');
  });

  it('degrades to joined segments when full_script is missing', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      scenes: [validScene()],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.narration_line).toBe('Magma rises beneath the volcano.');
    expect(result.full_script).toBe('Magma rises beneath the volcano.');
  });

  it('still parses legacy narration_line fields', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      scenes: [{
        visual_prompt: 'a cutaway diagram of a volcano with a clean lower third',
        motion_prompt: 'gentle camera push-in',
        narration_line: 'Magma rises beneath the volcano.',
        text_zone: 'lower_third',
        segment_type: 'dialogue',
      }],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.narration_line).toBe('Magma rises beneath the volcano.');
  });

  it('returns a structural single-scene fallback for malformed JSON', async () => {
    mockGenerateClaudeText.mockResolvedValue('not-json');

    const result = await expandExplainerScript(baseArgs);

    expect(result).toEqual({
      scenes: [{
        visual_prompt: expect.stringContaining('volcanoes'),
        motion_prompt: expect.any(String),
        narration_line: 'volcanoes',
        text_zone: 'lower_third',
        segment_type: 'dialogue',
        motion: { type: 'ken_burns', priority: 2, edit_steps: [] },
        transition_out: 'cut',
      }],
      music_mood: 'ambient',
    });
  });

  it('sends the registry prohibition against narrator and presenter figures', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({ scenes: [validScene()], music_mood: 'ambient' }));

    await expandExplainerScript(baseArgs);

    const systemPrompt = (mockGenerateClaudeText.mock.calls[0]![1].systemPrompt as string).toLowerCase();
    expect(systemPrompt).toContain('narrator');
    expect(systemPrompt).toContain('presenter');
  });

  it('defensively rewrites narrator-figure phrases in visual prompts', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      scenes: [validScene({ visual_prompt: 'A narrator explaining plate tectonics' })],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.visual_prompt.toLowerCase()).not.toContain('narrator');
    expect(result.scenes[0]!.visual_prompt).toContain('the subject');
  });

  it('coerces disallowed segment types and invalid text zones', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      scenes: [validScene({ segment_type: 'vocab', text_zone: 'left' })],
      music_mood: 'unknown',
    }));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.segment_type).toBe('dialogue');
    expect(result.scenes[0]!.text_zone).toBe('lower_third');
    expect(result.music_mood).toBe('ambient');
  });

  it('parses a valid motion object and transition_out as-is', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      scenes: [validScene({
        motion: { type: 'before_after', priority: 4, edit_steps: ['a seed sprouts a tiny green shoot, keep everything else identical', 'the shoot grows into a sapling, keep everything else identical'] },
        transition_out: 'morph',
      })],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.motion).toEqual({
      type: 'before_after',
      priority: 4,
      edit_steps: [
        'a seed sprouts a tiny green shoot, keep everything else identical',
        'the shoot grows into a sapling, keep everything else identical',
      ],
    });
    expect(result.scenes[0]!.transition_out).toBe('morph');
  });

  it('defaults motion and transition_out when missing or malformed', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      scenes: [validScene({ motion: undefined, transition_out: 'sideways' })],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.motion).toEqual({ type: 'ken_burns', priority: 2, edit_steps: [] });
    expect(result.scenes[0]!.transition_out).toBe('cut');
  });

  it('clamps edit_steps to 3, clamps priority to 1-5, and sanitizes narrator figures in edit_steps', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      scenes: [validScene({
        motion: {
          type: 'before_after',
          priority: 99,
          edit_steps: [
            'a narrator explaining the first label appears, keep everything else identical',
            'step 2, keep everything else identical',
            'step 3, keep everything else identical',
            'step 4 should be dropped, keep everything else identical',
          ],
        },
      })],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);
    const motion = result.scenes[0]!.motion!;

    expect(motion.priority).toBe(5);
    expect(motion.edit_steps).toHaveLength(3);
    expect(motion.edit_steps[0]).not.toContain('narrator');
    expect(motion.edit_steps[0]).toContain('the subject');
  });

  it("retires progressive_reveal (2026-07-23): remaps to ken_burns with edit_steps cleared, even though it's still a recognized type", async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      scenes: [validScene({
        motion: { type: 'progressive_reveal', priority: 5, edit_steps: ['label A appears', 'label B appears'] },
      })],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.motion).toEqual({ type: 'ken_burns', priority: 5, edit_steps: [] });
  });

  it('rejects an unknown motion.type but keeps other valid fields (field-level fallback)', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      scenes: [validScene({ motion: { type: 'zoom-enhance', priority: 3, edit_steps: [] } })],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.motion).toEqual({ type: 'ken_burns', priority: 3, edit_steps: [] });
  });

  it('includes factual grounding only when grounding text is present', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({ scenes: [validScene()], music_mood: 'ambient' }));

    await expandExplainerScript({
      ...baseArgs,
      groundingText: 'Mount St. Helens erupted in 1980.',
    });
    const groundedPrompt = mockGenerateClaudeText.mock.calls[0]![1].prompt as string;
    expect(groundedPrompt).toContain('SOURCE MATERIAL');
    expect(groundedPrompt).toContain('Mount St. Helens erupted in 1980.');

    mockGenerateClaudeText.mockClear();
    await expandExplainerScript(baseArgs);
    const ungroundedPrompt = mockGenerateClaudeText.mock.calls[0]![1].prompt as string;
    expect(ungroundedPrompt).not.toContain('SOURCE MATERIAL');
  });

  it('strips markdown fences around the JSON (Replicate has no structured-output param)', async () => {
    mockGenerateClaudeText.mockResolvedValue(
      '```json\n' + JSON.stringify({ scenes: [validScene()], music_mood: 'ambient' }) + '\n```',
    );

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]!.narration_line).toBe('Magma rises beneath the volcano.');
  });

  it('returns the structural fallback when the Claude call throws', async () => {
    mockGenerateClaudeText.mockRejectedValue(new Error('replicate 500'));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]!.narration_line).toBe('volcanoes');
  });

  it('passes a valid on_image_text through and treats null/missing as absent', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      full_script: 'Magma rises beneath the volcano.',
      scenes: [
        validScene({ on_image_text: 'KITTY HAWK' }),
        validScene({ on_image_text: null }),
        validScene(),
      ],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.on_image_text).toBe('KITTY HAWK');
    expect(result.scenes[1]!.on_image_text).toBeUndefined();
    expect(result.scenes[2]!.on_image_text).toBeUndefined();
  });

  it('drops (not truncates) an on_image_text over the word backstop', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      full_script: 'Magma rises beneath the volcano.',
      scenes: [validScene({ on_image_text: 'one two three four five six seven' })],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.on_image_text).toBeUndefined();
  });

  it('enforces the per-video on_image_text cap, keeping the first text scenes in order', async () => {
    // baseArgs: sceneCount 2, no targetTotalSeconds -> 2 * 5s = 10s target -> cap = 1.
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      full_script: 'Magma rises beneath the volcano.',
      scenes: [
        validScene({ on_image_text: 'FIRST' }),
        validScene(),
        validScene({ on_image_text: 'SECOND' }),
      ],
      music_mood: 'ambient',
    }));

    const result = await expandExplainerScript(baseArgs);

    expect(result.scenes[0]!.on_image_text).toBe('FIRST');
    expect(result.scenes[1]!.on_image_text).toBeUndefined();
    expect(result.scenes[2]!.on_image_text).toBeUndefined();
  });

  it('scales the cap with target length (~1 per 15s) and announces it in the user message', async () => {
    mockGenerateClaudeText.mockResolvedValue(JSON.stringify({
      full_script: 'Magma rises beneath the volcano.',
      scenes: [
        validScene({ on_image_text: 'ONE' }),
        validScene({ on_image_text: 'TWO' }),
        validScene({ on_image_text: 'THREE' }),
        validScene({ on_image_text: 'FOUR' }),
        validScene({ on_image_text: 'FIVE' }),
      ],
      music_mood: 'ambient',
    }));

    // 60s tier -> cap 4 (60/15). 90s would allow 6.
    const result = await expandExplainerScript({ ...baseArgs, sceneCount: 24, targetTotalSeconds: 60 });

    expect(result.scenes.map((scene) => scene.on_image_text)).toEqual(['ONE', 'TWO', 'THREE', 'FOUR', undefined]);
    const userMessage = mockGenerateClaudeText.mock.calls[0]![1].prompt as string;
    expect(userMessage).toContain('at most 4 scene(s)');
  });
});
