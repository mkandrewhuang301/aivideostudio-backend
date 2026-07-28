// src/routes/audioSeparation.ts
// Quote/trigger/status endpoints for the Editor's "Separate audio" tool. Closest analog:
// aiMusic.ts (userId 401 helper, quote GET, Idempotency-Key trigger POST, queue-add-failure
// refund + 503). IDOR-guarded throughout (T-20.1-13): a foreign clip/job never leaks existence.

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { audioSeparationQueue } from '../queue/audioSeparationQueue';
import {
  AudioSeparationNotFoundError,
  AudioSeparationValidationError,
  checkDailyRateLimit,
  createAudioSeparationJob,
  getAudioSeparationJob,
  InsufficientSeparationCreditsError,
  quoteAudioSeparation,
  quoteAudioClipSeparation,
  refundAudioSeparation,
  SeparationRateLimitedError,
} from '../services/audioSeparationService';

export const audioSeparationRouter = Router();

/** Shared status payload — identical for clip-sourced and stem-sourced jobs. */
function serializeJobStatus(job: {
  status: string; cost_credits: number;
  target_audio_clip_id: string | null; residual_audio_clip_id: string | null;
  failure_code: string | null; source_prior_volume: number | null;
  source_prior_enabled: boolean | null; source_prior_gain: number | null;
}) {
  return {
    status: job.status,
    cost_credits: job.cost_credits,
    target_audio_clip_id: job.target_audio_clip_id,
    residual_audio_clip_id: job.residual_audio_clip_id,
    failure_code: job.failure_code,
    // Undo state: a clip source restores volume; a stem source restores enabled/gain.
    source_prior_volume: job.source_prior_volume,
    source_prior_enabled: job.source_prior_enabled,
    source_prior_gain: job.source_prior_gain,
  };
}

function userId(req: Request, res: Response): string | undefined {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Unauthorized' });
    return undefined;
  }
  return req.user.dbUserId;
}

audioSeparationRouter.get('/clips/:clipId/audio-separation/quote', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  try {
    const quote = await quoteAudioSeparation(req.params.clipId as string, uid);
    res.status(200).json({ ...quote, enabled: config.audioSepEnabled });
  } catch (error) {
    // Ownership check inside quoteAudioSeparation makes this IDOR-safe — a foreign clip throws
    // NotFound (no existence leak), never a 403.
    if (error instanceof AudioSeparationNotFoundError) { res.status(404).json({ error: 'Clip not found' }); return; }
    if (error instanceof AudioSeparationValidationError) { res.status(422).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to quote audio separation' });
  }
});

audioSeparationRouter.post('/clips/:clipId/audio-separations', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  if (!config.audioSepEnabled) { res.status(503).json({ error: 'Audio separation is not enabled' }); return; }
  const idempotencyKey = req.header('Idempotency-Key')?.trim();
  if (!idempotencyKey || idempotencyKey.length > 100) {
    res.status(400).json({ error: 'A valid Idempotency-Key is required' }); return;
  }
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) { res.status(400).json({ error: 'A prompt describing the sound to remove is required' }); return; }

  try {
    await checkDailyRateLimit(uid);

    const created = await createAudioSeparationJob({
      userId: uid,
      clipId: req.params.clipId as string,
      prompt,
      idempotencyKey,
    });
    if (created.created) {
      try {
        await audioSeparationQueue.add('separate', { jobId: created.row.id }, { jobId: created.row.id });
      } catch {
        await refundAudioSeparation(created.row.id, 'queue_unavailable', 'Separation could not start');
        res.status(503).json({ error: 'Audio separation is temporarily unavailable' }); return;
      }
    }
    res.status(202).json({
      job_id: created.row.id,
      status: created.row.status,
      cost_credits: created.row.cost_credits,
    });
  } catch (error) {
    if (error instanceof SeparationRateLimitedError) { res.status(429).json({ error: 'Daily separation limit reached' }); return; }
    if (error instanceof AudioSeparationNotFoundError) { res.status(404).json({ error: 'Clip not found' }); return; }
    if (error instanceof InsufficientSeparationCreditsError) { res.status(402).json({ error: 'Not enough credits' }); return; }
    if (error instanceof AudioSeparationValidationError) { res.status(422).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to start audio separation' });
  }
});

audioSeparationRouter.get('/clips/:clipId/audio-separations/:jobId', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  const job = await getAudioSeparationJob(req.params.jobId as string);
  // IDOR guard (T-20.1-13): a job belonging to another user (or the wrong clip) is treated as
  // not-found — no existence leak, no cross-user status/volume disclosure.
  if (!job || job.user_id !== uid || job.source_clip_id !== req.params.clipId) {
    res.status(404).json({ error: 'Separation job not found' }); return;
  }
  res.status(200).json(serializeJobStatus(job));
});

// ─── Chained separation: source is an existing stem, not a clip ───────────────
// Either stem of a pair can be separated again, to arbitrary depth. Same pricing, same rate
// limit, same idempotency contract as the clip routes above — only the source differs.

audioSeparationRouter.get('/audio-clips/:audioClipId/audio-separation/quote', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  try {
    const quote = await quoteAudioClipSeparation(req.params.audioClipId as string, uid);
    res.status(200).json({ ...quote, enabled: config.audioSepEnabled });
  } catch (error) {
    if (error instanceof AudioSeparationNotFoundError) { res.status(404).json({ error: 'Audio clip not found' }); return; }
    if (error instanceof AudioSeparationValidationError) { res.status(422).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to quote audio separation' });
  }
});

audioSeparationRouter.post('/audio-clips/:audioClipId/audio-separations', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  if (!config.audioSepEnabled) { res.status(503).json({ error: 'Audio separation is not enabled' }); return; }
  const idempotencyKey = req.header('Idempotency-Key')?.trim();
  if (!idempotencyKey || idempotencyKey.length > 100) {
    res.status(400).json({ error: 'A valid Idempotency-Key is required' }); return;
  }
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) { res.status(400).json({ error: 'A prompt describing the sound to remove is required' }); return; }

  try {
    await checkDailyRateLimit(uid);

    const created = await createAudioSeparationJob({
      userId: uid,
      audioClipId: req.params.audioClipId as string,
      prompt,
      idempotencyKey,
    });
    if (created.created) {
      try {
        await audioSeparationQueue.add('separate', { jobId: created.row.id }, { jobId: created.row.id });
      } catch {
        await refundAudioSeparation(created.row.id, 'queue_unavailable', 'Separation could not start');
        res.status(503).json({ error: 'Audio separation is temporarily unavailable' }); return;
      }
    }
    res.status(202).json({
      job_id: created.row.id,
      status: created.row.status,
      cost_credits: created.row.cost_credits,
    });
  } catch (error) {
    if (error instanceof SeparationRateLimitedError) { res.status(429).json({ error: 'Daily separation limit reached' }); return; }
    if (error instanceof AudioSeparationNotFoundError) { res.status(404).json({ error: 'Audio clip not found' }); return; }
    if (error instanceof InsufficientSeparationCreditsError) { res.status(402).json({ error: 'Not enough credits' }); return; }
    if (error instanceof AudioSeparationValidationError) { res.status(422).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to start audio separation' });
  }
});

audioSeparationRouter.get('/audio-clips/:audioClipId/audio-separations/:jobId', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  const job = await getAudioSeparationJob(req.params.jobId as string);
  if (!job || job.user_id !== uid || job.source_audio_clip_id !== req.params.audioClipId) {
    res.status(404).json({ error: 'Separation job not found' }); return;
  }
  res.status(200).json(serializeJobStatus(job));
});
