export interface AudioSeparationInput {
  model: string;           // config.audioSepModel = 'fal-ai/sam-audio/separate'
  audioUrl: string;        // presigned R2 URL of the source clip's audio
  prompt: string;          // freeform "sound to remove"
  durationSeconds: number; // resolved server-side (CLAUDE.md rule #7 principle)
}

export interface AudioSeparationResult {
  target: Buffer;    // the removed sound
  residual: Buffer;  // everything else
  mimeType: 'audio/mpeg';
  providerRequestId?: string;
}

export interface AudioSeparationProvider {
  separate(input: AudioSeparationInput): Promise<AudioSeparationResult>;
}
