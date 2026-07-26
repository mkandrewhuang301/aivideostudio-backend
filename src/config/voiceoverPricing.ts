// src/config/voiceoverPricing.ts
// Server-owned deterministic quote for standalone AI Voiceover. Converts live provider list-price
// estimates into credit costs using the developer-approved constants from 20-VOICEOVER-COST-SPIKE.md.

import { AUDIO_VOICES, getAudioVoiceById, VoiceKind } from './audioVoices';

export const VOICEOVER_PRICING_VERSION = '2026-07-26a';

export const VOICEOVER_PRICING = {
  version: VOICEOVER_PRICING_VERSION,
  minimumCredits: 1,
  centsPerCredit: 1,
  /** Chirp 3 HD / Gemini preset list price: $0.00003 / character = 0.003 cents / character. */
  presetCentsPerCharacter: 0.003,
  /** qwen3-tts custom_voice / voice_clone list price: $0.02 / 1,000 characters = 0.002 cents / character. */
  cloneCentsPerCharacter: 0.002,
  /** App-enforced maximum script length (provider schemas either match or do not publish a limit). */
  maxScriptCharacters: 5000,
} as const;

export interface VoiceoverQuote {
  cost_credits: number;
  estimated_provider_cents: number;
  pricing_version: string;
}

export class VoiceoverQuoteError extends Error {}

function centsPerCharacterForKind(kind: VoiceKind): number {
  return kind === 'preset'
    ? VOICEOVER_PRICING.presetCentsPerCharacter
    : VOICEOVER_PRICING.cloneCentsPerCharacter;
}

/**
 * Deterministic server-side quote for a voiceover request.
 *
 * Formula (approved 2026-07-26):
 *   estimated_provider_cents = script_characters * provider_cents_per_character
 *   cost_credits = max(minimum_credits, ceil(estimated_provider_cents / cents_per_credit))
 *
 * Rejects unknown voices and scripts outside 1..5000 characters.
 */
export function quoteVoiceover({
  voiceId,
  scriptCharacters,
}: {
  voiceId: string;
  scriptCharacters: number;
}): VoiceoverQuote {
  const voice = getAudioVoiceById(voiceId);
  if (!voice) {
    throw new VoiceoverQuoteError(`Unknown voice: ${voiceId}`);
  }

  if (
    !Number.isInteger(scriptCharacters)
    || scriptCharacters < 1
    || scriptCharacters > VOICEOVER_PRICING.maxScriptCharacters
  ) {
    throw new VoiceoverQuoteError(
      `scriptCharacters must be an integer between 1 and ${VOICEOVER_PRICING.maxScriptCharacters}`,
    );
  }

  const estimatedProviderCents = scriptCharacters * centsPerCharacterForKind(voice.kind);
  const costCredits = Math.max(
    VOICEOVER_PRICING.minimumCredits,
    Math.ceil(estimatedProviderCents / VOICEOVER_PRICING.centsPerCredit),
  );

  return {
    cost_credits: costCredits,
    estimated_provider_cents: estimatedProviderCents,
    pricing_version: VOICEOVER_PRICING.version,
  };
}

/** All voice ids that can be quoted. Useful for route validation and tests. */
export function listVoiceoverVoiceIds(): string[] {
  return AUDIO_VOICES.map((voice) => voice.id);
}
