// src/services/providers/FalProvider.ts
// CLAUDE.md Rule 6: provider abstraction — this is the ONLY file that imports @fal-ai/client.
//
// Backs regular Kling v3 Standard image-to-video. Kling v3 Motion Control is a different model
// and intentionally remains on ReplicateProvider.ts (AI Influencer Pro stage 3).
//
// Live OpenAPI schema verified 2026-07-15:
// https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video/api
// Required: start_image_url. Duration is a string enum "3"..."15"; generate_audio is boolean.
// Output: { video: { url: string } }.
//
// Fal's queue API requires the endpoint ID as well as the request ID for status/result calls.
// providerPredictionId therefore stores "<endpointId>::<requestId>" without a schema migration.

import { fal, ApiError } from '@fal-ai/client';
import { ModelProvider, GenerationInput, DispatchResult, PredictionStatus } from './ModelProvider';

export const FAL_KLING_V3_STANDARD_I2V_MODEL = 'fal-ai/kling-video/v3/standard/image-to-video' as const;
const SUPPORTED_FAL_ENDPOINTS = new Set<string>([FAL_KLING_V3_STANDARD_I2V_MODEL]);

export function encodePredictionId(endpointId: string, requestId: string): string {
  return `${endpointId}::${requestId}`;
}

export function decodePredictionId(providerPredictionId: string): { endpointId: string; requestId: string } {
  const sep = providerPredictionId.indexOf('::');
  if (sep <= 0 || sep + 2 >= providerPredictionId.length) {
    throw new Error(`Malformed Fal prediction id: ${providerPredictionId}`);
  }
  return { endpointId: providerPredictionId.slice(0, sep), requestId: providerPredictionId.slice(sep + 2) };
}

export class FalProvider implements ModelProvider {
  async dispatch(input: GenerationInput, webhookUrl: string): Promise<DispatchResult> {
    if (input.model !== FAL_KLING_V3_STANDARD_I2V_MODEL) {
      throw new Error(`FalProvider does not support model: ${input.model}`);
    }

    const startImageUrl = input.referenceImages?.[0];
    if (!startImageUrl) throw new Error('Kling v3 Standard image-to-video requires one start image');
    if (!Number.isInteger(input.durationSeconds) || input.durationSeconds! < 3 || input.durationSeconds! > 15) {
      throw new Error('Kling v3 Standard duration must be an integer between 3 and 15 seconds');
    }
    const duration = String(input.durationSeconds) as
      | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | '11' | '12' | '13' | '14' | '15';

    const submitted = await fal.queue.submit(FAL_KLING_V3_STANDARD_I2V_MODEL, {
      input: {
        start_image_url: startImageUrl,
        duration,
        generate_audio: input.audioEnabled ?? true,
        ...(input.prompt.trim() ? { prompt: input.prompt.trim() } : {}),
      },
      webhookUrl,
    });

    return {
      providerPredictionId: encodePredictionId(FAL_KLING_V3_STANDARD_I2V_MODEL, submitted.request_id),
    };
  }

  async getStatus(providerPredictionId: string): Promise<PredictionStatus> {
    const { endpointId, requestId } = decodePredictionId(providerPredictionId);
    if (!SUPPORTED_FAL_ENDPOINTS.has(endpointId)) {
      throw new Error(`Unsupported Fal endpoint in prediction id: ${endpointId}`);
    }
    const queueStatus = await fal.queue.status(endpointId, { requestId });

    if (queueStatus.status === 'IN_QUEUE') return { status: 'starting' };
    if (queueStatus.status === 'IN_PROGRESS') return { status: 'processing' };

    // COMPLETED means the queue run ended; result() distinguishes success from provider failure.
    try {
      const result = await fal.queue.result(endpointId, { requestId });
      const outputUrl = (result.data as { video?: { url?: string } } | undefined)?.video?.url;
      if (!outputUrl) throw new Error('Fal result completed with no video.url in output');
      return { status: 'succeeded', outputUrl };
    } catch (err) {
      const message = err instanceof ApiError ? `Fal ${err.status}: ${err.message}` : String(err);
      return { status: 'failed', error: message };
    }
  }
}
