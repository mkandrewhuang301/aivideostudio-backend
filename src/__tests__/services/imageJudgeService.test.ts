// imageJudgeService tests: the judge is FAIL-OPEN by contract — every failure mode (disabled
// config, missing key, network error, non-OK, malformed verdict) must return { pass: true }.
// Fetch is mocked throughout; no real API calls.

jest.mock('../../config', () => ({
  config: {
    geminiApiKey: 'mock-gemini-key',
    imageJudgeEnabled: true,
    imageJudgeModel: 'gemini-3.5-flash',
  },
}));

const toBufferMock = jest.fn().mockResolvedValue(Buffer.from('resized-jpeg'));
jest.mock('sharp', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: toBufferMock,
  })),
}));

import { config } from '../../config';
import {
  hardenedEditPrompt,
  hardenedStillPrompt,
  judgeStill,
  shouldRegenerate,
} from '../../services/imageJudgeService';

const image = Buffer.from('fake-png');

function mockJudgeResponse(body: unknown, ok = true, status = 200): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  }) as unknown as jest.Mock;
}

function verdictBody(pass: boolean, reason?: string): unknown {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify(reason ? { pass, reason } : { pass }) }] } }],
  };
}

function sentPrompt(): string {
  const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0]![1].body as string);
  return body.contents[0].parts.find((p: { text?: string }) => p.text).text as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  (config as { imageJudgeEnabled: boolean }).imageJudgeEnabled = true;
  (config as { geminiApiKey: string }).geminiApiKey = 'mock-gemini-key';
});

describe('judgeStill fail-open contract', () => {
  it('passes immediately when the judge is disabled or the key is missing', async () => {
    global.fetch = jest.fn() as unknown as jest.Mock;
    (config as { imageJudgeEnabled: boolean }).imageJudgeEnabled = false;
    expect(await judgeStill(image, { visualPrompt: 'a barn', mode: 'fresh' })).toEqual({ pass: true });

    (config as { imageJudgeEnabled: boolean }).imageJudgeEnabled = true;
    (config as { geminiApiKey: string }).geminiApiKey = '';
    expect(await judgeStill(image, { visualPrompt: 'a barn', mode: 'fresh' })).toEqual({ pass: true });
    expect(global.fetch as jest.Mock).not.toHaveBeenCalled();
  });

  it('passes on network error, non-OK response, and malformed verdict', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as unknown as jest.Mock;
    expect(await judgeStill(image, { visualPrompt: 'a barn', mode: 'fresh' })).toEqual({ pass: true });

    mockJudgeResponse({}, false, 500);
    expect(await judgeStill(image, { visualPrompt: 'a barn', mode: 'fresh' })).toEqual({ pass: true });

    mockJudgeResponse({ candidates: [{ content: { parts: [{ text: 'not json at all' }] } }] });
    expect(await judgeStill(image, { visualPrompt: 'a barn', mode: 'fresh' })).toEqual({ pass: true });
  });
});

describe('judgeStill verdicts', () => {
  it('returns pass:true for a clean verdict', async () => {
    mockJudgeResponse(verdictBody(true));
    expect(await judgeStill(image, { visualPrompt: 'a barn', mode: 'fresh' })).toEqual({ pass: true });
  });

  it('returns the judge reason on fail (and a fallback reason when absent)', async () => {
    mockJudgeResponse(verdictBody(false, 'garbled text in the upper left'));
    expect(await judgeStill(image, { visualPrompt: 'a barn', mode: 'fresh' }))
      .toEqual({ pass: false, reason: 'garbled text in the upper left' });

    mockJudgeResponse(verdictBody(false));
    expect(await judgeStill(image, { visualPrompt: 'a barn', mode: 'fresh' }))
      .toEqual({ pass: false, reason: 'unspecified quality defect' });
  });

  it('strips markdown fences around the verdict JSON', async () => {
    mockJudgeResponse({ candidates: [{ content: { parts: [{ text: '```json\n{"pass": true}\n```' }] } }] });
    expect(await judgeStill(image, { visualPrompt: 'a barn', mode: 'fresh' })).toEqual({ pass: true });
  });
});

describe('judge prompt construction', () => {
  it('fresh + no on-image text -> forbids ALL text', async () => {
    mockJudgeResponse(verdictBody(true));
    await judgeStill(image, { visualPrompt: 'a 1901 wind tunnel', styleLabel: 'Flat Vector', mode: 'fresh' });
    const prompt = sentPrompt();
    expect(prompt).toContain('a 1901 wind tunnel');
    expect(prompt).toContain('Flat Vector');
    expect(prompt).toContain('must contain NO text, words, letters, or numbers at all');
  });

  it('fresh + on-image text -> demands the exact string and forbids all other text', async () => {
    mockJudgeResponse(verdictBody(true));
    await judgeStill(image, { visualPrompt: 'a hangar', mode: 'fresh', onImageText: '1903' });
    const prompt = sentPrompt();
    expect(prompt).toContain('exactly this text');
    expect(prompt).toContain('"1903"');
    expect(prompt).toContain('Any OTHER words, letters, or numbers anywhere are a defect');
  });

  it('edit mode -> checks the edit applied, no collage paste, no collateral changes', async () => {
    mockJudgeResponse(verdictBody(true));
    await judgeStill(image, {
      visualPrompt: 'a room', mode: 'edit', editStep: 'the empty fireplace catches fire',
    });
    const prompt = sentPrompt();
    expect(prompt).toContain('"the empty fireplace catches fire"');
    expect(prompt).toContain('large new hero object');
    expect(prompt).toContain('OUTSIDE the requested edit');
  });

  it('edit mode + baseImage -> BEFORE/AFTER comparison wording and two image parts', async () => {
    mockJudgeResponse(verdictBody(true));
    await judgeStill(image, {
      visualPrompt: 'a wing diagram', mode: 'edit', editStep: 'wing tips flex', baseImage: image,
    });
    const prompt = sentPrompt();
    expect(prompt).toContain('Image 1 is the frame BEFORE');
    expect(prompt).toContain('image 2 (AFTER) against image 1 (BEFORE)');
    expect(prompt).toContain('wires, struts, railings, lattices');
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0]![1].body as string);
    expect(body.contents[0].parts.filter((p: unknown) => typeof p === 'object' && p !== null && 'inline_data' in p)).toHaveLength(2);
  });
});

describe('retry helpers', () => {
  it('shouldRegenerate only on fail with budget remaining', () => {
    expect(shouldRegenerate({ pass: true }, { remaining: 3 })).toBe(false);
    expect(shouldRegenerate({ pass: false, reason: 'x' }, { remaining: 0 })).toBe(false);
    expect(shouldRegenerate({ pass: false, reason: 'x' }, { remaining: 1 })).toBe(true);
  });

  it('hardened prompts inject the rejection reason', () => {
    expect(hardenedStillPrompt('PROMPT', 'garbled text')).toContain('PROMPT');
    expect(hardenedStillPrompt('PROMPT', 'garbled text')).toContain('garbled text');
    expect(hardenedEditPrompt('STEP', 'collage look')).toContain('STEP');
    expect(hardenedEditPrompt('STEP', 'collage look')).toContain('collage look');
    expect(hardenedEditPrompt('STEP', 'collage look')).toContain('keep everything else in the frame identical');
  });
});
