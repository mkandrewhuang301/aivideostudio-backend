export type VoiceKind = 'preset' | 'system_clone';

export interface AudioVoicePublic {
  id: string;
  label: string;
  descriptor: string;
  kind: VoiceKind;
  previewUrl?: string;
}

export interface AudioVoiceDef extends AudioVoicePublic {
  provider: string;
  model?: string;
  speaker?: string;
  referenceR2Key?: string;
  referenceText?: string;
}

export const AUDIO_VOICES_VERSION = '2026-07-26a';

export const AUDIO_VOICES: AudioVoiceDef[] = [];

export type ClientAudioVoice = AudioVoicePublic;

export const CLIENT_AUDIO_VOICES: ClientAudioVoice[] = [];
