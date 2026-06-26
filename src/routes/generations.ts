// src/routes/generations.ts
// POST /api/generations — validates request, resolves duration (CLAUDE.md Rule 7: never -1),
// computes cost, gates on credits (creditCheckMiddleware), creates the generation row,
// dispatches via the ModelProvider abstraction (CLAUDE.md Rule 6: no Replicate code here directly
// beyond instantiating ReplicateProvider — all calls go through the interface).

import { Router, Request, Response, NextFunction } from 'express';
import { creditCheckMiddleware } from '../middleware/creditCheck';
import {
  resolveDurationSeconds,
  computeCostCredits,
  createGeneration,
  attachPredictionId,
  SUPPORTED_MODELS,
  type SupportedModel,
} from '../services/generationService';
import { ReplicateProvider } from '../services/providers/ReplicateProvider';
import { refundCredits } from '../services/creditService';
import { markRefunded } from '../services/generationService';
import { config } from '../config';
import type { GenerationInput } from '../services/providers/ModelProvider';

export const generationsRouter = Router();

const provider = new ReplicateProvider();

const VALID_RESOLUTIONS = ['480p', '720p'] as const;

interface ResolvedGenerationRequest {
  prompt: string;
  model: SupportedModel;
  durationSeconds: number;
  resolution: '480p' | '720p';
  aspectRatio: string;
  audioEnabled: boolean;
  cost: number;
}

declare global {
  namespace Express {
    interface Request {
      _resolved?: ResolvedGenerationRequest;
    }
  }
}

// Step 1: validate + resolve duration/cost, attach cost_credits to req.body so
// creditCheckMiddleware (mounted next) can read it per its existing contract.
function prepareCost(req: Request, res: Response, next: NextFunction): void {
  const { prompt, model = 'bytedance/seedance-2.0-fast', duration, resolution, aspect_ratio, audio_enabled } = req.body ?? {};

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'prompt is required', code: 'INVALID_PROMPT' });
    return;
  }
  if (!SUPPORTED_MODELS.includes(model)) {
    res.status(400).json({ error: `model must be one of: ${SUPPORTED_MODELS.join(', ')}`, code: 'INVALID_MODEL' });
    return;
  }
  if (!VALID_RESOLUTIONS.includes(resolution)) {
    res.status(400).json({ error: 'resolution must be one of 480p, 720p', code: 'INVALID_RESOLUTION' });
    return;
  }

  let durationSeconds: number;
  try {
    durationSeconds = resolveDurationSeconds(duration);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message, code: 'INVALID_DURATION' });
    return;
  }

  const cost = computeCostCredits({ durationSeconds, resolution, model: model as SupportedModel });

  req.body.cost_credits = cost;
  req._resolved = {
    prompt,
    model: model as SupportedModel,
    durationSeconds,
    resolution,
    aspectRatio: aspect_ratio ?? '16:9',
    audioEnabled: Boolean(audio_enabled),
    cost,
  };
  next();
}

generationsRouter.post('/', prepareCost, creditCheckMiddleware, async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const resolved = req._resolved as ResolvedGenerationRequest;

  try {
    const { id: generationId } = await createGeneration({
      user_id: req.user.dbUserId,
      model: resolved.model,
      status: 'pending',
      prompt: resolved.prompt,
      params: {
        resolution: resolved.resolution,
        duration: resolved.durationSeconds,
        aspect_ratio: resolved.aspectRatio,
        audio_enabled: resolved.audioEnabled,
      },
      cost_credits: resolved.cost,
    });

    const webhookUrl = `${config.publicBaseUrl}/webhooks/replicate`;
    const input: GenerationInput = {
      prompt: resolved.prompt,
      model: resolved.model,
      durationSeconds: resolved.durationSeconds,
      resolution: resolved.resolution,
      aspectRatio: resolved.aspectRatio,
      audioEnabled: resolved.audioEnabled,
    };

    let providerPredictionId: string;
    try {
      ({ providerPredictionId } = await provider.dispatch(input, webhookUrl));
    } catch (dispatchError) {
      console.error('[generations] Dispatch failed — refunding credits immediately:', dispatchError);
      await markRefunded(generationId);
      await refundCredits(req.user.dbUserId, resolved.cost, `dispatch-failure-${generationId}`);
      res.status(502).json({ error: 'Generation provider unavailable. Credits have been refunded.' });
      return;
    }

    await attachPredictionId(generationId, providerPredictionId);
    res.status(200).json({ generation_id: generationId, status: 'processing' });
  } catch (error) {
    console.error('[generations] Error dispatching generation:', error);
    res.status(500).json({ error: 'Failed to dispatch generation' });
  }
});
