// src/config/audioVoices.ts
// Server-driven voice roster for standalone AI Voiceover. Pipeline code resolves a voice row by id
// instead of hardcoding provider, model, speaker, or clone reference details.

export type VoiceKind = 'preset' | 'system_clone';

export interface AudioVoicePublic {
  id: string;
  label: string;
  descriptor: string;
  kind: VoiceKind;
  previewUrl?: string;
}

export interface AudioVoiceDef extends AudioVoicePublic {
  /** SERVER-ONLY. Provider family that will render this voice. */
  provider: string;
  /** SERVER-ONLY. Provider model id, when the provider uses one. */
  model?: string;
  /** SERVER-ONLY. Preset speaker name, for provider-specific preset routing. */
  speaker?: string;
  /** SERVER-ONLY. R2 key of the reference clip for system_clone voices. */
  referenceR2Key?: string;
  /** SERVER-ONLY. Verbatim transcript of the reference clip for system_clone voices. */
  referenceText?: string;
}

export const AUDIO_VOICES_VERSION = '2026-07-26a';

/**
 * R2 key + transcript for the cloned "anime narrator" voice (voice id 'voiceA').
 * Copied verbatim from geminiTtsService.ts so this config module stays self-contained.
 */
const VOICE_A_REFERENCE_R2_KEY = 'reference-voices/voiceA-clipA.mp3';
const VOICE_A_TRANSCRIPT =
  "They stood no chance. Then Jack came up with an idea. In theory, as long as it was under attack, the crystal horn rabbit couldn't activate its escape skill. So Jack planned to act as bait to lure the crystal horn rabbit, while Mary looked for an opportunity to strike. After devising the plan, Mary used earth magic.";

export const AUDIO_VOICES: AudioVoiceDef[] = [
  {
    id: 'kore',
    label: 'Kore',
    descriptor: 'Clear',
    kind: 'preset',
    previewUrl: 'voice-previews/kore.wav',
    provider: 'google',
    model: 'chirp3-hd',
    speaker: 'Kore',
  },
  {
    id: 'zephyr',
    label: 'Zephyr',
    descriptor: 'Bright',
    kind: 'preset',
    previewUrl: 'voice-previews/zephyr.wav',
    provider: 'google',
    model: 'chirp3-hd',
    speaker: 'Zephyr',
  },
  {
    id: 'aoede',
    label: 'Aoede',
    descriptor: 'Warm',
    kind: 'preset',
    previewUrl: 'voice-previews/aoede.wav',
    provider: 'google',
    model: 'chirp3-hd',
    speaker: 'Aoede',
  },
  {
    id: 'puck',
    label: 'Puck',
    descriptor: 'Energetic',
    kind: 'preset',
    previewUrl: 'voice-previews/puck.wav',
    provider: 'google',
    model: 'chirp3-hd',
    speaker: 'Puck',
  },
  {
    id: 'charon',
    label: 'Charon',
    descriptor: 'Deep',
    kind: 'preset',
    previewUrl: 'voice-previews/charon.wav',
    provider: 'google',
    model: 'chirp3-hd',
    speaker: 'Charon',
  },
  {
    id: 'orus',
    label: 'Orus',
    descriptor: 'Calm',
    kind: 'preset',
    previewUrl: 'voice-previews/orus.wav',
    provider: 'google',
    model: 'chirp3-hd',
    speaker: 'Orus',
  },
  {
    id: 'voiceA',
    label: 'Anime Narrator',
    descriptor: 'Cloned',
    kind: 'system_clone',
    previewUrl: 'voice-previews/voicea.wav',
    provider: 'replicate',
    model: 'qwen/qwen3-tts',
    referenceR2Key: VOICE_A_REFERENCE_R2_KEY,
    referenceText: VOICE_A_TRANSCRIPT,
  },
];

export type ClientAudioVoice = AudioVoicePublic;

/**
 * Client-facing projection. Provider routing and clone reference material are removed before any
 * route serializer can touch the roster.
 */
export const CLIENT_AUDIO_VOICES: ClientAudioVoice[] = AUDIO_VOICES.map(({
  provider,
  model,
  speaker,
  referenceR2Key,
  referenceText,
  ...publicFields
}) => publicFields);

/** Server-only voice lookup by id. */
export function getAudioVoiceById(id: string): AudioVoiceDef | undefined {
  return AUDIO_VOICES.find((voice) => voice.id === id);
}
