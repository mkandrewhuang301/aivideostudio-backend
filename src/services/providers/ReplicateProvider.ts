// src/services/providers/ReplicateProvider.ts
// CLAUDE.md Rule 6: provider abstraction — this is the ONLY file that imports the `replicate` package.
// CLAUDE.md Rule 7: durationSeconds must already be resolved (never -1) by the caller before dispatch().

import Replicate from 'replicate';
import { config } from '../../config';
import { ModelProvider, GenerationInput, DispatchResult, PredictionStatus } from './ModelProvider';

const replicate = new Replicate({ auth: config.replicateApiToken });

export class ReplicateProvider implements ModelProvider {
  async dispatch(input: GenerationInput, webhookUrl: string): Promise<DispatchResult> {
    let replicateInput: Record<string, unknown>;
    // GPT Image 2 virtual IDs encode quality; resolve to the real Replicate model slug.
    const GPT_QUALITY: Record<string, string> = {
      'openai/gpt-image-2-high':   'high',
      'openai/gpt-image-2-medium': 'medium',
      'openai/gpt-image-2-low':    'low',
      'openai/gpt-image-2':        'high',
    };
    const replicateModel = input.model in GPT_QUALITY ? 'openai/gpt-image-2' : input.model;

    if (input.mediaType === 'image') {
      const isGptImage = input.model in GPT_QUALITY;
      const gptQuality = GPT_QUALITY[input.model] ?? input.imageQuality ?? 'high';
      replicateInput = {
        prompt: input.prompt,
        aspect_ratio: input.imageAspectRatio ?? '1:1',
        ...(isGptImage ? { quality: gptQuality } : {}),
        ...(input.referenceImages?.length
          ? { [isGptImage ? 'input_images' : 'image_input']: input.referenceImages }
          : {}),
      };
    } else if (input.mediaType === 'avatar') {
      // DreamActor M2.0: portrait image + driving video — no text prompt
      replicateInput = {
        image: input.avatarImage,
        video: input.avatarDrivingVideo,
        ...(input.cutFirstSecond !== undefined ? { cut_first_second: input.cutFirstSecond } : {}),
      };
    } else if (input.mediaType === 'upscale') {
      // ByteDance Video Upscaler: input video + optional quality params
      // 'pro' tier is Replicate-allowlist-only; always 'standard' unless explicitly set
      replicateInput = {
        video: input.upscalerInputVideo,
        ...(input.upscalerTier ? { processing_type: input.upscalerTier } : {}),
        ...(input.upscalerScene ? { scene: input.upscalerScene } : {}),
        ...(input.upscalerTargetResolution ? { target_resolution: input.upscalerTargetResolution } : {}),
        ...(input.upscalerTargetFps ? { target_fps: input.upscalerTargetFps } : {}),
      };
    } else if (input.model === 'xai/grok-imagine-video-1.5') {
      // Image-to-video, mandatory single `image` field — no bracket-token references,
      // no generate_audio (Replicate schema has no audio toggle; always synchronized).
      replicateInput = {
        prompt: input.prompt,
        image: input.referenceImages?.[0],
        duration: input.durationSeconds,
        resolution: input.resolution,
        aspect_ratio: input.aspectRatio,
      };
    } else {
      // Video model input (CLAUDE.md Rule 7: durationSeconds never -1)
      replicateInput = {
        prompt: input.prompt,
        duration: input.durationSeconds,
        resolution: input.resolution,
        aspect_ratio: input.aspectRatio,
        generate_audio: input.audioEnabled,
      };
      if (input.referenceImages?.length) replicateInput.reference_images = input.referenceImages;
      if (input.referenceVideos?.length) replicateInput.reference_videos = input.referenceVideos;
    }

    const prediction = await replicate.predictions.create({
      model: replicateModel as `${string}/${string}`,
      input: replicateInput,
      webhook: webhookUrl,
      webhook_events_filter: ['completed'],
    });
    return { providerPredictionId: prediction.id };
  }

  async getStatus(providerPredictionId: string): Promise<PredictionStatus> {
    const prediction = await replicate.predictions.get(providerPredictionId);
    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    return {
      status: prediction.status as PredictionStatus['status'],
      outputUrl,
      error: prediction.error ? String(prediction.error) : undefined,
    };
  }
}
