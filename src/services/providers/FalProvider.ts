// src/services/providers/FalProvider.ts
// CLAUDE.md Rule 6: provider abstraction — this is the ONLY file that imports @fal-ai/client.
//
// Backs ONE model today: Kling v3 Motion Control — the SAME logical model id
// ('kwaivgi/kling-v3-motion-control') ReplicateProvider.ts already used, so cost lookups
// (generationService.ts's computeKlingMotionControlCost) and the generation row's own `model`
// column are unchanged; only the DISPATCH implementation moves providers. AI Influencer Pro's 3rd
// pipeline stage (influencerProWorker.ts) is the sole live consumer, moved here because Fal's
// per-second rate is roughly HALF Replicate's current Kling v3 pricing for the audio-on config
// that preset always uses (2026-07-15, live-verified via both dashboards — see the updated
// KLING_MOTION_RATE comment in generationService.ts). Every other model stays on Replicate;
// this does not replace ReplicateProvider.ts, it's dispatched from a second call site.
//
// Live-verified schema (2026-07-15, https://fal.ai/models/fal-ai/kling-video/v3/standard/motion-control/api
// and .../pro/motion-control/api): required image_url + video_url + character_orientation
// ('image'|'video'); optional prompt, keep_original_sound (default true). Field NAMES differ from
// Replicate's (image/video, no _url suffix) and mode is baked into the ENDPOINT PATH instead of an
// input field — this file is where that translation lives, nowhere else.
// Output schema: { video: { url: string } } — also different from Replicate's raw output shape.
//
// Fal's queue API requires the ENDPOINT ID (not just a request id) to check status or fetch a
// result. `providerPredictionId` therefore encodes BOTH as "<endpointId>::<requestId>" so
// getStatus() and the webhook handler (routes/webhooks/fal.ts) can recover which endpoint a bare
// prediction id belongs to without a schema migration — safe as long as this provider only ever
// dispatches to the two Kling v3 tiers below; a future second Fal-backed model would need the
// same encoding scheme.

import { fal, ApiError } from '@fal-ai/client';
import { ModelProvider, GenerationInput, DispatchResult, PredictionStatus } from './ModelProvider';

export const KLING_ENDPOINTS: Record<'std' | 'pro', string> = {
  std: 'fal-ai/kling-video/v3/standard/motion-control',
  pro: 'fal-ai/kling-video/v3/pro/motion-control',
};

export function encodePredictionId(endpointId: string, requestId: string): string {
  return `${endpointId}::${requestId}`;
}

export function decodePredictionId(providerPredictionId: string): { endpointId: string; requestId: string } {
  const sep = providerPredictionId.indexOf('::');
  if (sep === -1) {
    throw new Error(`Malformed Fal prediction id (missing endpoint prefix): ${providerPredictionId}`);
  }
  return { endpointId: providerPredictionId.slice(0, sep), requestId: providerPredictionId.slice(sep + 2) };
}

export class FalProvider implements ModelProvider {
  async dispatch(input: GenerationInput, webhookUrl: string): Promise<DispatchResult> {
    if (input.model !== 'kwaivgi/kling-v3-motion-control') {
      throw new Error(`FalProvider does not support model: ${input.model}`);
    }

    const endpointId = KLING_ENDPOINTS[input.klingMotionMode ?? 'std'];

    const submitted = await fal.queue.submit(endpointId, {
      input: {
        image_url: input.klingMotionImage,
        video_url: input.klingMotionVideo,
        character_orientation: input.klingMotionCharacterOrientation ?? 'image',
        ...(input.klingMotionPrompt ? { prompt: input.klingMotionPrompt } : {}),
        keep_original_sound: input.klingMotionKeepOriginalSound ?? true,
      },
      webhookUrl,
    });

    return { providerPredictionId: encodePredictionId(endpointId, submitted.request_id) };
  }

  async getStatus(providerPredictionId: string): Promise<PredictionStatus> {
    const { endpointId, requestId } = decodePredictionId(providerPredictionId);
    const queueStatus = await fal.queue.status(endpointId, { requestId });

    if (queueStatus.status === 'IN_QUEUE') return { status: 'starting' };
    if (queueStatus.status === 'IN_PROGRESS') return { status: 'processing' };

    // 'COMPLETED' at the queue level only means "finished running" — Fal has no queue-level
    // failed/canceled status (unlike Replicate); success vs. failure is only knowable by
    // actually fetching the result, which throws ApiError for a failed job.
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
