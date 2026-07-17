// Video translation contract verified against fal-ai/heygen/v2/translate/speed on 2026-07-17.
// Keep the language values exact: fal validates this field as an enum, including parentheticals.

export const FAL_VIDEO_TRANSLATE_SPEED_MODEL = 'fal-ai/heygen/v2/translate/speed' as const;
export const VIDEO_TRANSLATION_MAX_SECONDS = 8 * 60;
export const VIDEO_TRANSLATION_CREDITS_PER_SECOND = 5;

export const VIDEO_TRANSLATION_LANGUAGES = [
  'Spanish',
  'French',
  'German',
  'Italian',
  'Portuguese',
  'Hindi',
  'Japanese',
  'Korean',
  'Mandarin',
  'Arabic',
  'Russian',
  'Indonesian',
  'Vietnamese (Vietnam)',
  'Turkish',
  'Polish',
  'Thai (Thailand)',
  'Filipino',
  'Dutch',
] as const;

export type VideoTranslationLanguage = typeof VIDEO_TRANSLATION_LANGUAGES[number];

const languageSet = new Set<string>(VIDEO_TRANSLATION_LANGUAGES);

export function isVideoTranslationLanguage(value: unknown): value is VideoTranslationLanguage {
  return typeof value === 'string' && languageSet.has(value);
}

export function computeVideoTranslationCost(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('duration must be a positive number');
  }
  return Math.ceil(durationSeconds) * VIDEO_TRANSLATION_CREDITS_PER_SECOND;
}
