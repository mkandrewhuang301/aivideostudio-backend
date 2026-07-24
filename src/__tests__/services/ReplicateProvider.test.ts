// src/__tests__/services/ReplicateProvider.test.ts
// Kling v3 motion control (kwaivgi/kling-v3-motion-control) dispatch-branch unit test.
// Plan 09.6-03: standalone provider-layer integration — no 9.6 preset wires these fields yet.
// Pins the LIVE-verified input field names (image, video, mode) so a wrong-field-name regression
// fails loudly (T-09.6-16).

jest.mock('../../config', () => ({
  config: {
    replicateApiToken: 'fake-replicate-token',
    replicateWebhookSecret: 'whsec_fake',
  },
}));

const mockCreate = jest.fn();
const mockGet = jest.fn();

class MockReplicate {
  predictions: { create: jest.Mock; get: jest.Mock };
  constructor() {
    this.predictions = { create: mockCreate, get: mockGet };
  }
}

jest.mock('replicate', () => ({
  __esModule: true,
  default: MockReplicate,
}));

import { ReplicateProvider, parseWhisperXWords } from '../../services/providers/ReplicateProvider';
import type { GenerationInput } from '../../services/providers/ModelProvider';

describe('ReplicateProvider.dispatch — kling-v3-motion-control', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockGet.mockReset();
  });

  it('dispatches kling-v3-motion-control with the live-verified image/video/mode input keys', async () => {
    mockCreate.mockResolvedValue({ id: 'pred_1' });

    const provider = new ReplicateProvider();
    const input: GenerationInput = {
      prompt: '',
      model: 'kwaivgi/kling-v3-motion-control',
      klingMotionImage: 'https://r2.example.com/character.jpg',
      klingMotionVideo: 'https://r2.example.com/driver.mp4',
      klingMotionMode: 'std',
    };

    const result = await provider.dispatch(input, 'https://example.com/webhooks/replicate');

    expect(result).toEqual({ providerPredictionId: 'pred_1' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('kwaivgi/kling-v3-motion-control');
    expect(callArgs.webhook_events_filter).toEqual(['completed']);
    expect(callArgs.input.image).toBe('https://r2.example.com/character.jpg');
    expect(callArgs.input.video).toBe('https://r2.example.com/driver.mp4');
    expect(callArgs.input.mode).toBe('std');
  });
});

describe('parseWhisperXWords (caption-timing fill, not drop)', () => {
  it('keeps a word whose timestamps are missing instead of dropping it', () => {
    // Middle word has null start/end — the old parser dropped it, losing an anchor.
    const out = parseWhisperXWords({
      segments: [{ start: 0, end: 3, words: [
        { word: 'a', start: 0, end: 1 },
        { word: 'b', start: null, end: null },
        { word: 'c', start: 2, end: 3 },
      ] }],
    });
    expect(out.map((w) => w.word)).toEqual(['a', 'b', 'c']);
    // 'b' is interpolated between a.start(0) and c.start(2) → ~1.
    expect(out[1]!.start).toBeCloseTo(1, 5);
  });

  it('fills a fully-untimed trailing segment from its segment bounds (the tail-burst bug)', () => {
    // Late segment aligned nothing at word level — old parser dropped its whole run, cramming the
    // script tail. Now those words are spread across the segment [3,6] frame.
    const out = parseWhisperXWords({
      segments: [
        { start: 0, end: 3, words: [
          { word: 'intro', start: 0, end: 1.5 },
          { word: 'clear', start: 1.5, end: 3 },
        ] },
        { start: 3, end: 6, words: [
          { word: 'the', start: null, end: null },
          { word: 'ending', start: null, end: null },
          { word: 'burst', start: null, end: null },
        ] },
      ],
    });
    expect(out.map((w) => w.word)).toEqual(['intro', 'clear', 'the', 'ending', 'burst']);
    const tail = out.slice(2);
    // Spread across [3,6], not collapsed at the end.
    expect(tail[0]!.start).toBeCloseTo(3, 5);
    expect(tail[2]!.end).toBeCloseTo(6, 5);
    // Strictly progressing, not all bunched at one instant.
    expect(tail[1]!.start).toBeGreaterThan(tail[0]!.start);
    expect(tail[2]!.start).toBeGreaterThan(tail[1]!.start);
  });

  it('produces globally monotonic non-decreasing times across segments', () => {
    const out = parseWhisperXWords({
      segments: [
        { start: 0, end: 2, words: [{ word: 'x', start: 0, end: 2 }] },
        // Glitchy backwards start — must be clamped forward, never rewind.
        { start: 1, end: 4, words: [{ word: 'y', start: 1, end: 4 }] },
      ],
    });
    let prev = 0;
    for (const w of out) {
      expect(w.start).toBeGreaterThanOrEqual(prev);
      expect(w.end).toBeGreaterThanOrEqual(w.start);
      prev = w.end;
    }
  });

  it('skips empty-text words and returns [] for no segments', () => {
    expect(parseWhisperXWords({ segments: [] })).toEqual([]);
    const out = parseWhisperXWords({
      segments: [{ start: 0, end: 1, words: [{ word: '', start: 0, end: 1 }, { word: 'ok', start: 0.2, end: 1 }] }],
    });
    expect(out.map((w) => w.word)).toEqual(['ok']);
  });
});
