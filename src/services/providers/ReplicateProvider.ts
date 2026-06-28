// src/services/providers/ReplicateProvider.ts
// CLAUDE.md Rule 6: provider abstraction — this is the ONLY file that imports the `replicate` package.
// CLAUDE.md Rule 7: durationSeconds must already be resolved (never -1) by the caller before dispatch().

import Replicate from 'replicate';
import { config } from '../../config';
import { ModelProvider, GenerationInput, DispatchResult, PredictionStatus } from './ModelProvider';

const replicate = new Replicate({ auth: config.replicateApiToken });

export class ReplicateProvider implements ModelProvider {
  async dispatch(input: GenerationInput, webhookUrl: string): Promise<DispatchResult> {
    // Build Replicate input — only include reference arrays when non-empty (D-23, D-24).
    // Prompt already has @Image1/@Video1 appended by prepareCost in generations.ts.
    const replicateInput: Record<string, unknown> = {
      prompt: input.prompt,
      duration: input.durationSeconds,
      resolution: input.resolution,
      aspect_ratio: input.aspectRatio,
      audio: input.audioEnabled,
    };
    if (input.referenceImages?.length) replicateInput.reference_images = input.referenceImages;
    if (input.referenceVideos?.length) replicateInput.reference_videos = input.referenceVideos;

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
