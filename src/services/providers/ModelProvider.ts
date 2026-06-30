// src/services/providers/ModelProvider.ts
// Provider abstraction interface. CLAUDE.md Rule 6: all Replicate calls go through this
// interface; no Replicate-specific code may appear in controllers or generationService callers.

export interface GenerationInput {
  prompt: string;
  model: string;
  mediaType?: 'video' | 'image';        // routing flag for provider dispatch; defaults to 'video' when absent
  // Video-specific (undefined for image generations)
  durationSeconds?: number;              // NEVER -1 when present (CLAUDE.md Rule 7)
  resolution?: '480p' | '720p' | '1080p' | '4k';
  aspectRatio?: string;
  audioEnabled?: boolean;
  referenceImages?: string[];            // presigned R2 URLs; @Image1 auto-appended to prompt (D-23)
  referenceVideos?: string[];            // presigned R2 URLs; @Video1 auto-appended to prompt (D-24)
  // Image-specific (undefined for video generations)
  width?: number;                        // e.g. 1024 — Flux models accept width/height directly
  height?: number;                       // e.g. 1024
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
