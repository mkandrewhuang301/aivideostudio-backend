// src/services/providers/ModelProvider.ts
// Provider abstraction interface. CLAUDE.md Rule 6: all Replicate calls go through this
// interface; no Replicate-specific code may appear in controllers or generationService callers.

export interface GenerationInput {
  prompt: string;
  model: string;
  mediaType?: 'video' | 'image' | 'avatar' | 'upscale' | 'character_replace' | 'faceswap' | 'chain';
  // Video-specific (undefined for image/avatar/upscale generations)
  durationSeconds?: number;              // NEVER -1 when present (CLAUDE.md Rule 7)
  resolution?: '480p' | '720p' | '1080p' | '4k';
  aspectRatio?: string;
  audioEnabled?: boolean;
  referenceImages?: string[];            // presigned R2 URLs; @Image1 auto-appended to prompt (D-23)
  referenceVideos?: string[];            // presigned R2 URLs; @Video1 auto-appended to prompt (D-24)
  // Image-specific (undefined for video/avatar/upscale generations)
  imageAspectRatio?: string;  // e.g. "1:1" | "4:3" | "3:4" | "16:9" | "9:16"
  imageSize?: '2K' | '3K';   // Seedream output resolution; '2K' = 2048px (default), '3K' = 3072px
  imageQuality?: 'high' | 'medium' | 'low'; // GPT Image 2 only — controls output fidelity vs. cost
  // Avatar-specific — DreamActor M2.0 (bytedance/dreamactor-m2.0)
  avatarImage?: string;        // presigned URL — portrait source image
  avatarDrivingVideo?: string; // presigned URL — motion/expression driver video
  cutFirstSecond?: boolean;    // trim 1s lead-in transition; Replicate default is true
  // Upscale-specific — ByteDance Video Upscaler (bytedance/video-upscaler)
  upscalerInputVideo?: string;         // presigned URL — video to upscale
  upscalerTier?: 'standard' | 'pro';  // 'pro' requires Replicate allowlist; always 'standard' until enabled
  upscalerScene?: 'aigc' | 'short_series' | 'ugc' | 'old_film' | 'common';
  upscalerTargetResolution?: string;   // '720p' | '1080p' | '2k' | '4k'
  upscalerTargetFps?: 24 | 30 | 60 | 120;
  // Image-upscale-specific — Recraft Crisp Upscale (recraft-ai/recraft-crisp-upscale)
  // Distinct field from upscalerInputVideo: this is an image enhancer, not the video upscaler.
  upscalerInputImage?: string;         // presigned URL — image to upscale; entire model input is { image }
  // Character-replace-specific — Wan 2.2 Animate Replace (wan-video/wan-2.2-animate-replace)
  characterReplaceVideo?: string; // presigned URL — source video whose background/motion/lighting is kept
  characterReplaceImage?: string; // presigned URL — character image that replaces the person in the video
  // 09.6 D-04: Wan's own merge_audio defaults TRUE (preserves the driver clip's audio in the
  // output). Set false for presets that mux a separate default audio track afterward (Marlon) so
  // the raw dispatch output is silent — a clean Plan-01 silent master. Undefined/true preserves
  // ai-influencer's existing behavior exactly (no postprocess, driver-clip audio stays).
  characterReplaceMergeAudio?: boolean;
  // Faceswap-specific — Easel Advanced Face Swap (easel/advanced-face-swap)
  swapImage?: string;    // presigned URL — user's source face (the face to place)
  targetImage?: string;  // presigned URL — image the face is placed onto
  hairSource?: 'target' | 'user'; // default 'target'
  // Chain-specific (09.6, D-01/D-05) — the resolved user photo slot(s) feeding the chain's
  // image_stage (e.g. UVU's 1-2 keyframe source photos). No dispatch consumer yet (Plan 05).
  chainInputImages?: string[];
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
