// src/services/providers/ModelProvider.ts
// Provider abstraction interface. CLAUDE.md Rule 6: all Replicate calls go through this
// interface; no Replicate-specific code may appear in controllers or generationService callers.

export interface GenerationInput {
  prompt: string;
  durationSeconds: number; // NEVER -1; resolved server-side before this call (CLAUDE.md Rule 7)
  resolution: '480p' | '720p'; // Seedance 2.0 Fast only supports 480p and 720p
  aspectRatio: string;
  audioEnabled: boolean;
  referenceAssetKeys?: string[];
}

export interface DispatchResult {
  providerPredictionId: string;
}

export interface PredictionStatus {
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  outputUrl?: string;
  error?: string;
}

export interface ModelProvider {
  dispatch(input: GenerationInput, webhookUrl: string): Promise<DispatchResult>;
  getStatus(providerPredictionId: string): Promise<PredictionStatus>;
}
