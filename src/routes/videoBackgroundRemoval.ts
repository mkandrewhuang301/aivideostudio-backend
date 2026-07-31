// src/routes/videoBackgroundRemoval.ts
// Quote/trigger/status/undo endpoints for Studio's "Remove background" tool. Closest analog:
// audioSeparation.ts (userId 401 helper, quote GET, Idempotency-Key trigger POST, queue-add-failure
// refund + 503). IDOR-guarded throughout: a foreign clip/job never leaks existence.

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import multer from 'multer';
import { config } from '../config';
import { videoBackgroundRemovalQueue } from '../queue/videoBackgroundRemovalQueue';
import { BACKGROUND_COLORS } from '../services/providers/VideoBackgroundRemovalProvider';
import { r2, R2_BUCKET } from '../storage/r2';
import {
  applyOnDeviceBackgroundRemoval,
  BgRemovalInProgressError,
  BgRemovalRateLimitedError,
  checkDailyRateLimit,
  createVideoBackgroundRemovalJob,
  findVideoBackgroundRemovalByIdempotency,
  getBgRemovalJob,
  InsufficientBgRemovalCreditsError,
  parseBackgroundColor,
  quoteVideoBackgroundRemoval,
  redoBackgroundRemoval,
  refundBgRemoval,
  undoBackgroundRemoval,
  VideoBgRemovalNotFoundError,
  VideoBgRemovalValidationError,
} from '../services/videoBackgroundRemovalService';

export const videoBackgroundRemovalRouter = Router();

const ON_DEVICE_OUTPUT_MAX_BYTES = 1024 * 1024 * 1024;
const onDeviceOutputUpload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, _file, callback) => callback(null, `apple-vision-matte-${randomUUID()}`),
  }),
  limits: { fileSize: ON_DEVICE_OUTPUT_MAX_BYTES },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype === 'video/quicktime'),
});

function serializeJobStatus(job: {
  status: string;
  cost_credits: number;
  background_color: string;
  output_r2_key: string | null;
  source_prior_r2_key: string | null;
  failure_code: string | null;
}) {
  return {
    status: job.status,
    cost_credits: job.cost_credits,
    background_color: job.background_color,
    // Whether the clip's media was swapped, so the client knows to refresh the clip and whether
    // an undo affordance applies. R2 keys themselves are internal — never the provider URL.
    applied: Boolean(job.output_r2_key),
    can_undo: job.status === 'completed' && Boolean(job.source_prior_r2_key),
    failure_code: job.failure_code,
  };
}

function userId(req: Request, res: Response): string | undefined {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Unauthorized' });
    return undefined;
  }
  return req.user.dbUserId;
}

videoBackgroundRemovalRouter.get('/clips/:clipId/background-removal/quote', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  try {
    const quote = await quoteVideoBackgroundRemoval(req.params.clipId as string, uid);
    res.status(200).json({
      ...quote,
      enabled: config.videoBgRemovalEnabled,
      background_colors: BACKGROUND_COLORS,
    });
  } catch (error) {
    // Ownership check inside quoteVideoBackgroundRemoval makes this IDOR-safe — a foreign clip
    // throws NotFound (no existence leak), never a 403.
    if (error instanceof VideoBgRemovalNotFoundError) { res.status(404).json({ error: 'Clip not found' }); return; }
    if (error instanceof VideoBgRemovalValidationError) { res.status(422).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to quote background removal' });
  }
});

videoBackgroundRemovalRouter.post('/clips/:clipId/background-removals', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  if (!config.videoBgRemovalEnabled) { res.status(503).json({ error: 'Background removal is not enabled' }); return; }
  const idempotencyKey = req.header('Idempotency-Key')?.trim();
  if (!idempotencyKey || idempotencyKey.length > 100) {
    res.status(400).json({ error: 'A valid Idempotency-Key is required' }); return;
  }

  try {
    // Defaults to 'Transparent' when omitted; an unknown value is a 422, never a silent fallback.
    const backgroundColor = parseBackgroundColor(req.body?.background_color);

    await checkDailyRateLimit(uid);

    const created = await createVideoBackgroundRemovalJob({
      userId: uid,
      clipId: req.params.clipId as string,
      backgroundColor,
      idempotencyKey,
    });
    if (created.created) {
      try {
        await videoBackgroundRemovalQueue.add(
          'remove-background',
          { jobId: created.row.id },
          { jobId: created.row.id },
        );
      } catch {
        await refundBgRemoval(created.row.id, 'queue_unavailable', 'Background removal could not start');
        res.status(503).json({ error: 'Background removal is temporarily unavailable' }); return;
      }
    }
    res.status(202).json({
      job_id: created.row.id,
      status: created.row.status,
      cost_credits: created.row.cost_credits,
    });
  } catch (error) {
    if (error instanceof BgRemovalRateLimitedError) { res.status(429).json({ error: 'Daily background removal limit reached' }); return; }
    if (error instanceof BgRemovalInProgressError) { res.status(409).json({ error: 'Background removal is already running for this clip' }); return; }
    if (error instanceof VideoBgRemovalNotFoundError) { res.status(404).json({ error: 'Clip not found' }); return; }
    if (error instanceof InsufficientBgRemovalCreditsError) { res.status(402).json({ error: 'Not enough credits' }); return; }
    if (error instanceof VideoBgRemovalValidationError) { res.status(422).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to start background removal' });
  }
});

// Apple Vision runs on the user's device and uploads only the finished HEVC-with-alpha movie.
// It is a zero-credit path: this endpoint persists the result and swaps the clip atomically, but
// never invokes fal/Bria or the provider queue.
videoBackgroundRemovalRouter.post(
  '/clips/:clipId/background-removals/on-device',
  onDeviceOutputUpload.single('file'),
  async (req, res) => {
    const uid = userId(req, res);
    if (!uid) {
      if (req.file) await unlink(req.file.path).catch(() => {});
      return;
    }
    const idempotencyKey = req.header('Idempotency-Key')?.trim();
    if (!idempotencyKey || idempotencyKey.length > 100) {
      if (req.file) await unlink(req.file.path).catch(() => {});
      res.status(400).json({ error: 'A valid Idempotency-Key is required' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'A QuickTime background-removal result is required' });
      return;
    }

    let uploadedR2Key: string | null = null;
    try {
      const replay = await findVideoBackgroundRemovalByIdempotency(uid, idempotencyKey);
      if (replay) {
        res.status(200).json({
          job_id: replay.id,
          status: replay.status,
          cost_credits: replay.cost_credits,
          applied: Boolean(replay.output_r2_key),
          can_undo: replay.status === 'completed' && Boolean(replay.source_prior_r2_key),
        });
        return;
      }

      // Ownership/media/duration validation happens before any durable object is created.
      await quoteVideoBackgroundRemoval(req.params.clipId as string, uid);

      uploadedR2Key = `video-background-removal/${uid}/${randomUUID()}.mov`;
      await new Upload({
        client: r2,
        params: {
          Bucket: R2_BUCKET,
          Key: uploadedR2Key,
          Body: createReadStream(req.file.path),
          ContentType: 'video/quicktime',
        },
      }).done();

      const applied = await applyOnDeviceBackgroundRemoval({
        userId: uid,
        clipId: req.params.clipId as string,
        idempotencyKey,
        outputR2Key: uploadedR2Key,
      });
      res.status(applied.created ? 201 : 200).json({
        job_id: applied.row.id,
        status: applied.row.status,
        cost_credits: 0,
        applied: Boolean(applied.row.output_r2_key),
        can_undo: Boolean(applied.row.source_prior_r2_key),
      });
    } catch (error) {
      if (uploadedR2Key) {
        await r2.send(new DeleteObjectCommand({
          Bucket: R2_BUCKET,
          Key: uploadedR2Key,
        })).catch(() => {});
      }
      if (error instanceof BgRemovalInProgressError) {
        res.status(409).json({ error: 'Background removal is already running for this clip' });
        return;
      }
      if (error instanceof VideoBgRemovalNotFoundError) {
        res.status(404).json({ error: 'Clip not found' });
        return;
      }
      if (error instanceof VideoBgRemovalValidationError) {
        res.status(422).json({ error: error.message });
        return;
      }
      console.error('[video-background-removal] On-device result upload failed:', error);
      res.status(500).json({ error: 'Failed to save background-removed clip' });
    } finally {
      await unlink(req.file.path).catch(() => {});
    }
  },
);

videoBackgroundRemovalRouter.get('/clips/:clipId/background-removals/:jobId', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  const job = await getBgRemovalJob(req.params.jobId as string);
  // IDOR guard: a job belonging to another user (or the wrong clip) is treated as not-found — no
  // existence leak, no cross-user status disclosure.
  if (!job || job.user_id !== uid || job.source_clip_id !== req.params.clipId) {
    res.status(404).json({ error: 'Background removal job not found' }); return;
  }
  res.status(200).json(serializeJobStatus(job));
});

// Undo restores the clip's original media. It does NOT refund — the provider work was performed
// and billed; undo is an editing action, not a failure.
videoBackgroundRemovalRouter.post('/clips/:clipId/background-removals/:jobId/undo', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  const job = await getBgRemovalJob(req.params.jobId as string);
  if (!job || job.user_id !== uid || job.source_clip_id !== req.params.clipId) {
    res.status(404).json({ error: 'Background removal job not found' }); return;
  }
  try {
    await undoBackgroundRemoval(req.params.jobId as string, uid);
    res.status(200).json({ status: 'undone' });
  } catch (error) {
    if (error instanceof VideoBgRemovalNotFoundError) { res.status(404).json({ error: 'Background removal job not found' }); return; }
    if (error instanceof VideoBgRemovalValidationError) { res.status(422).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to undo background removal' });
  }
});

// Redo only swaps back to the job's retained processed R2 object. It never re-runs inference or
// charges credits, and the service rejects the operation if any newer media edit intervened.
videoBackgroundRemovalRouter.post('/clips/:clipId/background-removals/:jobId/redo', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  const job = await getBgRemovalJob(req.params.jobId as string);
  if (!job || job.user_id !== uid || job.source_clip_id !== req.params.clipId) {
    res.status(404).json({ error: 'Background removal job not found' }); return;
  }
  try {
    await redoBackgroundRemoval(req.params.jobId as string, uid);
    res.status(200).json({ status: 'redone' });
  } catch (error) {
    if (error instanceof VideoBgRemovalNotFoundError) { res.status(404).json({ error: 'Background removal job not found' }); return; }
    if (error instanceof VideoBgRemovalValidationError) { res.status(422).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to redo background removal' });
  }
});
