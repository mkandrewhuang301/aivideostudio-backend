jest.mock('../../config', () => ({
  config: {
    openaiApiKey: 'mock-openai-key',
  },
}));

import { pickBestCandidateIndex } from '../../services/openaiScriptService';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const candidates = [
  'https://r2.example.com/scene-0.png',
  'https://r2.example.com/scene-1.png',
  'https://r2.example.com/scene-2.png',
];

function responseWith(content: string, ok = true) {
  return {
    ok,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('pickBestCandidateIndex', () => {
  it('returns the valid zero-based winner index', async () => {
    mockFetch.mockResolvedValue(responseWith('{"winner_index":1}'));

    await expect(pickBestCandidateIndex(candidates, 'volcano diagram', 'lower_third')).resolves.toBe(1);
  });

  it('falls back to candidate zero for malformed content', async () => {
    mockFetch.mockResolvedValue(responseWith('not-json'));

    await expect(pickBestCandidateIndex(candidates, 'volcano diagram', 'lower_third')).resolves.toBe(0);
  });

  it('falls back to candidate zero when the network call throws', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    await expect(pickBestCandidateIndex(candidates, 'volcano diagram', 'lower_third')).resolves.toBe(0);
  });

  it('rejects out-of-range and non-numeric-type winner indexes', async () => {
    mockFetch
      .mockResolvedValueOnce(responseWith('{"winner_index":5}'))
      .mockResolvedValueOnce(responseWith('{"winner_index":"1"}'));

    await expect(pickBestCandidateIndex(candidates, 'volcano diagram', 'lower_third')).resolves.toBe(0);
    await expect(pickBestCandidateIndex(candidates, 'volcano diagram', 'lower_third')).resolves.toBe(0);
  });

  it('returns zero for one candidate without making a network call', async () => {
    await expect(pickBestCandidateIndex([candidates[0]!], 'volcano diagram', 'lower_third')).resolves.toBe(0);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends all candidate images in order after the rubric text', async () => {
    mockFetch.mockResolvedValue(responseWith('{"winner_index":0}'));

    await pickBestCandidateIndex(candidates, 'volcano diagram', 'upper_third');

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    const content = body.messages[0].content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('style match');
    expect(content[0].text).toMatch(/NO narrator\/presenter\/speaker/i);
    expect(content[0].text).toContain('upper_third');
    expect(content.slice(1)).toEqual(candidates.map((url) => ({
      type: 'image_url',
      image_url: { url },
    })));
  });
});
