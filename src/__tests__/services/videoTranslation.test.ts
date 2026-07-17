import {
  computeVideoTranslationCost,
  isVideoTranslationLanguage,
  VIDEO_TRANSLATION_LANGUAGES,
} from '../../services/videoTranslation';

describe('videoTranslation contract', () => {
  it('keeps the verified 18-value language enum exact', () => {
    expect(VIDEO_TRANSLATION_LANGUAGES).toHaveLength(18);
    expect(isVideoTranslationLanguage('Thai (Thailand)')).toBe(true);
    expect(isVideoTranslationLanguage('Thai')).toBe(false);
  });

  it('bills each started source second at 5 credits', () => {
    expect(computeVideoTranslationCost(1)).toBe(5);
    expect(computeVideoTranslationCost(1.01)).toBe(10);
    expect(computeVideoTranslationCost(479.2)).toBe(2400);
    expect(() => computeVideoTranslationCost(0)).toThrow(/positive/);
  });
});
