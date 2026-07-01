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

    if (input.mediaType === 'image') {
      const ar = input.imageAspectRatio ?? '1:1';
      if (input.model === 'openai/gpt-image-2') {
        // GPT Image 2 only accepts "1:1", "3:2", "2:3"
        const landscape = ['4:3', '16:9', '3:2', '21:9'].includes(ar);
        const portrait  = ['3:4', '9:16', '2:3'].includes(ar);
        const gptAr = landscape ? '3:2' : portrait ? '2:3' : '1:1';
        replicateInput = { prompt: input.prompt, aspect_ratio: gptAr, quality: 'high' };
      } else {
        // Seedream 5 Lite + Seedream 4.5: use size + aspect_ratio
        replicateInput = { prompt: input.prompt, aspect_ratio: ar, size: '2K' };
      }
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
    } else {
      // Video model input (CLAUDE.md Rule 7: durationSeconds never -1)
      replicateInput = {
        prompt: input.prompt,
        duration: input.durationSeconds,
        resolution: input.resolution,
        aspect_ratio: input.aspectRatio,
        audio: input.audioEnabled,
      };
      if (input.referenceImages?.length) replicateInput.reference_images = input.referenceImages;
      if (input.referenceVideos?.length) replicateInput.reference_videos = input.referenceVideos;
    }

    const prediction = await replicate.predictions.create({
      model: input.model as `${string}/${string}`,
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
