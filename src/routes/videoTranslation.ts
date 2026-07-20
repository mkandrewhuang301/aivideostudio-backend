// POST /api/generations/:id/translate — derives a translated video from an owned completed row.
// The client never supplies a media URL: this route re-signs the source R2 object itself, which
// prevents SSRF and guarantees that only the caller's own completed generations are translated.

import { Router, Request, Response } from 'express';
import {
  attachPredictionId,
  createGeneration,
  getGenerationById,
  markFailed,
} from '../services/generationService';
import { deductCredits, refundCredits } from '../services/creditService';
import { getGenerationPresignedUrl } from '../services/archivalService';
import { probeDurationSeconds } from '../services/mediaProbe';
import { FalProvider } from '../services/providers/FalProvider';
import { getFalWebhookUrl } from '../config';
import {
  computeVideoTranslationCost,
  FAL_VIDEO_TRANSLATE_SPEED_MODEL,
  isVideoTranslationLanguage,
  VIDEO_TRANSLATION_MAX_SECONDS,
} from '../services/videoTranslation';

export const videoTranslationRouter = Router();
const falProvider = new FalProvider();

videoTranslationRouter.post('/:id/translate', async (req: Request, res: Response) => {
  const userId = req.user?.dbUserId;
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const outputLanguage = req.body?.output_language;
  if (!isVideoTranslationLanguage(outputLanguage)) {
    res.status(400).json({ error: 'Choose a supported translation language.', code: 'INVALID_LANGUAGE' });
    return;
  }

  try {
    const source = await getGenerationById(req.params.id as string, userId);
    if (!source || source.status !== 'completed' || !source.r2_key) {
      res.status(404).json({ error: 'Completed source video not found.', code: 'SOURCE_NOT_FOUND' });
      return;
    }
    if (source.media_type === 'image' || source.media_type === 'faceswap') {
      res.status(400).json({ error: 'Only videos can be translated.', code: 'SOURCE_NOT_VIDEO' });
      return;
    }

    const sourceUrl = await getGenerationPresignedUrl(source.r2_key);
    const durationSeconds = await probeDurationSeconds(sourceUrl);
    if (durationSeconds == null) {
      res.status(422).json({ error: 'Could not read the source video duration.', code: 'DURATION_UNAVAILABLE' });
      return;
    }
    if (durationSeconds > VIDEO_TRANSLATION_MAX_SECONDS) {
      res.status(400).json({ error: 'Translate Video supports clips up to 8 minutes.', code: 'VIDEO_TOO_LONG' });
      return;
    }

    const cost = computeVideoTranslationCost(durationSeconds);
    if (!(await deductCredits(userId, cost))) {
      res.status(402).json({ error: 'Insufficient credits', code: 'INSUFFICIENT_CREDITS' });
      return;
    }

    let generationId: string | undefined;
    try {
      const sourceParams = (source.params ?? {}) as Record<string, unknown>;
      ({ id: generationId } = await createGeneration({
        user_id: userId,
        model: FAL_VIDEO_TRANSLATE_SPEED_MODEL,
        status: 'pending',
        prompt: null,
        media_type: 'video',
        // A derived output inherits the source's moderation provenance. Translating a real-face
        // generation cannot turn it into a non-real-face path merely because no new upload was
        // attached to this request.
        has_real_face_input: source.has_real_face_input,
        cost_credits: cost,
        params: {
          tool: 'video_translation',
          source_generation_id: source.id,
          output_language: outputLanguage,
          source_duration_seconds: durationSeconds,
          duration: Math.ceil(durationSeconds),
          resolution: sourceParams.resolution,
          aspect_ratio: sourceParams.aspect_ratio,
          audio_enabled: true,
          has_reference: true,
        },
      }));

      const { providerPredictionId } = await falProvider.dispatch({
        prompt: '',
        model: FAL_VIDEO_TRANSLATE_SPEED_MODEL,
        mediaType: 'video',
        durationSeconds: Math.ceil(durationSeconds),
        referenceVideos: [sourceUrl],
        videoTranslationLanguage: outputLanguage,
      }, getFalWebhookUrl());

      await attachPredictionId(generationId, providerPredictionId);
      res.status(200).json({ generation_id: generationId, status: 'processing', cost_credits: cost });
    } catch (error) {
      console.error('[videoTranslation] Dispatch failed:', error);
      if (generationId) await markFailed(generationId, 'provider_error');
      await refundCredits(userId, cost, `translation-dispatch-failure-${generationId ?? source.id}`);
      res.status(502).json({ error: 'Translation service unavailable. Credits have been refunded.' });
    }
  } catch (error) {
    console.error('[videoTranslation] Source validation failed:', error);
    res.status(500).json({ error: 'Could not prepare this video for translation.' });
  }
});
