import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import multer from 'multer';
import { Upload } from '@aws-sdk/lib-storage';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, eq } from 'drizzle-orm';
import { config } from '../config';
import { FORMATS_BY_ID, VIDEO_SUMMARY_FORMAT } from '../config/formats';
import { db } from '../db/client';
import { referenceUploads } from '../db/schema';
import { r2, R2_BUCKET } from '../storage/r2';
import { concurrencyGate } from '../middleware/concurrencyGate';
import { isPromptFlagged, promptModerationMiddleware } from '../middleware/promptModeration';
import { getUploadPresignedUrl } from '../services/archivalService';
import { deductCredits, refundCredits } from '../services/creditService';
import { createGeneration, markFailed } from '../services/generationService';
import { scanInputMedia } from '../services/hiveService';
import { probeDurationSeconds } from '../services/mediaProbe';
import {
  computeVideoSummaryCost,
  isOutputDurationProportionate,
  type VideoSummaryMode,
} from '../services/videoSummaryService';
import { videoSummaryQueue } from '../queue/videoSummaryQueue';

export const videoSummariesRouter = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTPUT_DURATIONS = new Set([30, 60, 90]);
const ASPECT_RATIOS = new Set(['1:1', '9:16', '16:9']);
const MAX_SOURCE_DURATION_SECONDS = 60 * 60;
const MAX_CONTEXT_CHARS = 600;
const SUMMARY_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const SUMMARY_VIDEO_MIMES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/mpeg': 'mpeg',
  'video/webm': 'webm',
};

const summaryUpload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, _file, callback) => callback(null, `video-summary-${randomUUID()}`),
  }),
  limits: { fileSize: SUMMARY_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype in SUMMARY_VIDEO_MIMES),
});

// Production path for long videos: the authenticated service authorizes an exact object key,
// MIME, and size, then the iOS client PUTs directly to private R2. This avoids sending a 30-minute
// episode through the Railway service and keeps bucket credentials off-device.
videoSummariesRouter.post('/upload-intent', async (req: Request, res: Response) => {
  const userId = req.user?.dbUserId;
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const mimeType = typeof req.body?.mime_type === 'string' ? req.body.mime_type : '';
  const sizeBytes = Number(req.body?.size_bytes);
  if (!(mimeType in SUMMARY_VIDEO_MIMES)) {
    res.status(400).json({ error: 'Unsupported source video format', code: 'INVALID_SOURCE_VIDEO' });
    return;
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > SUMMARY_UPLOAD_MAX_BYTES) {
    res.status(400).json({ error: 'Source video must be 2 GB or smaller', code: 'SOURCE_FILE_TOO_LARGE' });
    return;
  }

  try {
    const extension = SUMMARY_VIDEO_MIMES[mimeType]!;
    const r2Key = `uploads/${userId}/${randomUUID()}.${extension}`;
    const [row] = await db.insert(referenceUploads).values({
      user_id: userId,
      r2_key: r2Key,
      mime_type: mimeType,
      kind: 'summary_source',
    }).returning({ id: referenceUploads.id });
    const uploadUrl = await getSignedUrl(r2, new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: r2Key,
      ContentType: mimeType,
      ContentLength: sizeBytes,
    }), { expiresIn: 3600 });
    res.status(200).json({
      id: row.id,
      upload_url: uploadUrl,
      mime_type: mimeType,
      required_headers: { 'Content-Type': mimeType },
    });
  } catch (err) {
    console.error('[video-summaries] Upload intent failed:', err);
    res.status(500).json({ error: 'Failed to prepare source upload' });
  }
});

videoSummariesRouter.post('/upload/:id/complete', async (req: Request, res: Response) => {
  const userId = req.user?.dbUserId;
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const uploadId = req.params.id as string;
  if (!UUID_PATTERN.test(uploadId)) {
    res.status(400).json({ error: 'Invalid upload id', code: 'INVALID_UPLOAD' });
    return;
  }
  try {
    const [upload] = await db
      .select({ r2Key: referenceUploads.r2_key, mimeType: referenceUploads.mime_type })
      .from(referenceUploads)
      .where(and(eq(referenceUploads.id, uploadId), eq(referenceUploads.user_id, userId)));
    if (!upload || !(upload.mimeType in SUMMARY_VIDEO_MIMES)) {
      res.status(404).json({ error: 'Owned source upload not found', code: 'UPLOAD_NOT_FOUND' });
      return;
    }
    const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: upload.r2Key }));
    const sizeBytes = Number(head.ContentLength ?? 0);
    if (sizeBytes <= 0 || sizeBytes > SUMMARY_UPLOAD_MAX_BYTES) {
      res.status(400).json({ error: 'Uploaded source is empty or too large', code: 'INVALID_SOURCE_VIDEO' });
      return;
    }
    res.status(200).json({ id: uploadId, mime_type: upload.mimeType });
  } catch (err) {
    console.error('[video-summaries] Upload finalization failed:', err);
    res.status(400).json({ error: 'Source upload did not complete', code: 'UPLOAD_INCOMPLETE' });
  }
});

// Compatibility fallback for older clients. Full episodes must not pass through the general 50MB
// memoryStorage reference endpoint; multer writes a scoped temp file and lib-storage streams it
// into R2, so process memory stays bounded.
videoSummariesRouter.post('/upload', summaryUpload.single('file'), async (req: Request, res: Response) => {
  const userId = req.user?.dbUserId;
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'No supported video file provided', code: 'INVALID_SOURCE_VIDEO' });
    return;
  }

  try {
    const extension = SUMMARY_VIDEO_MIMES[req.file.mimetype]!;
    const r2Key = `uploads/${userId}/${randomUUID()}.${extension}`;
    await new Upload({
      client: r2,
      params: {
        Bucket: R2_BUCKET,
        Key: r2Key,
        Body: createReadStream(req.file.path),
        ContentType: req.file.mimetype,
      },
    }).done();
    const [row] = await db.insert(referenceUploads).values({
      user_id: userId,
      r2_key: r2Key,
      mime_type: req.file.mimetype,
      kind: 'summary_source',
    }).returning({ id: referenceUploads.id });
    res.status(200).json({ id: row.id, mime_type: req.file.mimetype });
  } catch (err) {
    console.error('[video-summaries] Source upload failed:', err);
    res.status(500).json({ error: 'Failed to upload summary source' });
  } finally {
    await unlink(req.file.path).catch(() => {});
  }
});

videoSummariesRouter.post(
  '/',
  promptModerationMiddleware,
  concurrencyGate,
  async (req: Request, res: Response) => {
    const userId = req.user?.dbUserId;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const uploadId = typeof req.body?.upload_id === 'string' ? req.body.upload_id : '';
    const requestedMode = (req.body?.mode ?? 'episode') as VideoSummaryMode;
    const legacyPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const explicitContext = typeof req.body?.context === 'string' ? req.body.context.trim() : '';
    const context = explicitContext || (requestedMode === 'theme' ? legacyPrompt : '');
    // Focused-story mode is retired. Keep accepting the old wire value during client rollout, but
    // normalize every job to a full chronological summary and treat the old prompt as context.
    const mode: VideoSummaryMode = 'episode';
    const outputDurationSeconds = Number(req.body?.output_duration_seconds ?? 60);
    const aspectRatio = typeof req.body?.aspect_ratio === 'string' ? req.body.aspect_ratio : '9:16';
    const includeMusic = req.body?.include_music !== false;
    const explainerFormat = FORMATS_BY_ID.explainer;
    const voiceId = typeof req.body?.voice_id === 'string'
      ? req.body.voice_id
      : VIDEO_SUMMARY_FORMAT?.voice_default;

    if (!UUID_PATTERN.test(uploadId)) {
      res.status(400).json({ error: 'A valid upload_id is required', code: 'INVALID_UPLOAD' });
      return;
    }
    if (requestedMode !== 'theme' && requestedMode !== 'episode') {
      res.status(400).json({ error: "mode must be 'theme' or 'episode'", code: 'INVALID_MODE' });
      return;
    }
    if (context.length > MAX_CONTEXT_CHARS) {
      res.status(400).json({ error: `Context must be ${MAX_CONTEXT_CHARS} characters or fewer`, code: 'INVALID_CONTEXT' });
      return;
    }
    if (!OUTPUT_DURATIONS.has(outputDurationSeconds)) {
      res.status(400).json({ error: 'output_duration_seconds must be 30, 60, or 90', code: 'INVALID_DURATION' });
      return;
    }
    if (!ASPECT_RATIOS.has(aspectRatio)) {
      res.status(400).json({ error: "aspect_ratio must be '1:1', '9:16', or '16:9'", code: 'INVALID_ASPECT_RATIO' });
      return;
    }
    if (!explainerFormat || !voiceId || !VIDEO_SUMMARY_FORMAT?.voices.some((voice) => voice.id === voiceId)) {
      res.status(400).json({ error: 'Invalid voice', code: 'INVALID_VOICE' });
      return;
    }
    if (context && await isPromptFlagged(context)) {
      res.status(400).json({ error: 'This context violates our content policy', code: 'content_policy_violation' });
      return;
    }

    let cost = 0;
    let generationId: string | undefined;
    try {
      const [upload] = await db
        .select({ r2Key: referenceUploads.r2_key, mimeType: referenceUploads.mime_type })
        .from(referenceUploads)
        .where(and(eq(referenceUploads.id, uploadId), eq(referenceUploads.user_id, userId)));
      if (!upload || !upload.mimeType.startsWith('video/')) {
        res.status(404).json({ error: 'Owned video upload not found', code: 'UPLOAD_NOT_FOUND' });
        return;
      }

      const sourceUrl = await getUploadPresignedUrl(upload.r2Key);
      const sourceDurationSeconds = await probeDurationSeconds(sourceUrl);
      if (sourceDurationSeconds == null) {
        res.status(400).json({ error: 'Could not read the source video', code: 'INVALID_SOURCE_VIDEO' });
        return;
      }
      if (sourceDurationSeconds < 10 || sourceDurationSeconds > MAX_SOURCE_DURATION_SECONDS) {
        res.status(400).json({
          error: 'Source video must be between 10 seconds and 60 minutes',
          code: 'SOURCE_DURATION_UNSUPPORTED',
        });
        return;
      }

      // Guardrail, not a preference: a long source squeezed into the shortest tier cannot carry a
      // causal story, only disconnected moments. Only the extreme mismatch is refused; a merely
      // thin ask is passed through with the recommendation echoed back for the client to surface.
      const proportion = isOutputDurationProportionate(sourceDurationSeconds, outputDurationSeconds);
      if (proportion.severity === 'blocked') {
        res.status(400).json({
          error: proportion.message,
          code: 'OUTPUT_DURATION_TOO_SHORT_FOR_SOURCE',
          recommended_output_seconds: proportion.recommendedSeconds,
        });
        return;
      }

      // Mirrors generations.ts's inputMediaGate (CLAUDE.md Rule 4 parity) — this route has no
      // middleware equivalent, so the input NSFW scan is inlined here. Runs pre-deduction so a
      // block never charges the user.
      const inputScan = await scanInputMedia(sourceUrl);
      if (inputScan.blocked) {
        res.status(400).json({
          error: 'This video cannot be used because it may contain explicit content.',
          code: 'INPUT_MEDIA_BLOCKED',
        });
        return;
      }

      cost = computeVideoSummaryCost(sourceDurationSeconds, outputDurationSeconds, includeMusic);
      if (!await deductCredits(userId, cost)) {
        res.status(402).json({ error: 'Insufficient credits', code: 'INSUFFICIENT_CREDITS', cost_credits: cost });
        return;
      }

      try {
        ({ id: generationId } = await createGeneration({
          user_id: userId,
          model: config.videoSummaryModel,
          status: 'pending',
          prompt: context || 'Video summary',
          params: {
            format_id: 'video-explainer',
            summary_mode: mode,
            user_context_supplied: Boolean(context),
            source_duration_seconds: sourceDurationSeconds,
            output_duration_seconds: outputDurationSeconds,
            aspect_ratio: aspectRatio,
            ref_upload_ids: [uploadId],
            stage_label: 'Queued…',
          },
          cost_credits: cost,
          media_type: 'video',
          has_real_face_input: false,
        }));
      } catch (err) {
        await refundCredits(userId, cost, `video-summary-create-${userId}-${uploadId}`);
        throw err;
      }

      try {
        await videoSummaryQueue.add('generate', {
          generationId,
          userId,
          cost,
          sourceR2Key: upload.r2Key,
          sourceMimeType: upload.mimeType,
          sourceDurationSeconds,
          mode,
          theme: null,
          context: context || null,
          outputDurationSeconds,
          aspectRatio: aspectRatio as '9:16' | '16:9',
          voiceId,
          includeMusic,
        });
      } catch (err) {
        await markFailed(generationId, 'generic_error');
        await refundCredits(userId, cost, `video-summary-dispatch-${generationId}`);
        res.status(502).json({ error: 'Summary service unavailable. Credits have been refunded.' });
        return;
      }

      res.status(200).json({
        generation_id: generationId,
        status: 'processing',
        cost_credits: cost,
        source_duration_seconds: sourceDurationSeconds,
      });
    } catch (err) {
      console.error('[video-summaries] Failed to create summary:', err);
      res.status(500).json({ error: 'Failed to create video summary' });
    }
  },
);
