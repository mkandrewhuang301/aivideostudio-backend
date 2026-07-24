export interface MusicReferenceImage {
  mimeType: 'image/jpeg' | 'image/png';
  data: Buffer;
}

export interface MusicGenerationInput {
  model: string;
  prompt: string;
  referenceImages: MusicReferenceImage[];
}

export interface MusicGenerationResult {
  audio: Buffer;
  mimeType: 'audio/mpeg';
  providerRequestId?: string;
}

export interface MusicGenerationProvider {
  generate(input: MusicGenerationInput): Promise<MusicGenerationResult>;
}
