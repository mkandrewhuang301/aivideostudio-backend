export const VOICEOVER_PRICING_VERSION = '2026-07-26a';

export const VOICEOVER_PRICING = {
  version: VOICEOVER_PRICING_VERSION,
  minimumCredits: 1,
  centsPerCredit: 1,
  presetCentsPerCharacter: 0.003,
  cloneCentsPerCharacter: 0.002,
} as const;

export interface VoiceoverQuote {
  cost_credits: number;
  estimated_provider_cents: number;
  pricing_version: string;
}

export function quoteVoiceover(_input: {
  voiceId: string;
  scriptCharacters: number;
}): VoiceoverQuote {
  throw new Error('not implemented');
}
