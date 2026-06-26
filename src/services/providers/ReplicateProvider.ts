// src/services/providers/ReplicateProvider.ts
// CLAUDE.md Rule 6: provider abstraction — this is the ONLY file that imports the `replicate` package.
// CLAUDE.md Rule 7: durationSeconds must already be resolved (never -1) by the caller before dispatch().

import Replicate from 'replicate';
import { config } from '../../config';
import { ModelProvider, GenerationInput, DispatchResult, PredictionStatus } from './ModelProvider';

const replicate = new Replicate({ auth: config.replicateApiToken });

export class ReplicateProvider implements ModelProvider {
  async dispatch(input: GenerationInput, webhookUrl: string): Promise<DispatchResult> {
    const prediction = await replicate.predictions.create({
      model: input.model as `${string}/${string}`,
      input: {
        prompt: input.prompt,
        duration: input.durationSeconds,
        resolution: input.resolution,
        aspect_ratio: input.aspectRatio,
        audio: input.audioEnabled,
      },
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
