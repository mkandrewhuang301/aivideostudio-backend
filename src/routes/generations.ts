// src/routes/generations.ts
// POST /api/generations — validates request, resolves duration (CLAUDE.md Rule 7: never -1),
// computes cost, gates on credits (creditCheckMiddleware), creates the generation row,
// dispatches via the ModelProvider abstraction (CLAUDE.md Rule 6: no Replicate code here directly
// beyond instantiating ReplicateProvider — all calls go through the interface).

import { Router, Request, Response, NextFunction } from 'express';
import { creditCheckMiddleware } from '../middleware/creditCheck';
import { promptModerationMiddleware } from '../middleware/promptModeration';
import {
  resolveDurationSeconds,
  computeCostCredits,
  computeImageCostCredits,
  computeDreamActorCost,
  computeUpscalerCost,
  computeGrokImagineCost,
  createGeneration,
  attachPredictionId,
  listGenerations,
  getGenerationById,
  softDeleteGeneration,
  SUPPORTED_MODELS,
  MODEL_RESOLUTIONS,
  SUPPORTED_IMAGE_MODELS,
  SUPPORTED_AVATAR_MODELS,
  SUPPORTED_UPSCALER_MODELS,
  SUPPORTED_GROK_MODELS,
  type SupportedModel,
} from '../services/generationService';
import { ReplicateProvider } from '../services/providers/ReplicateProvider';
import { refundCredits } from '../services/creditService';
import { classifyFailureReason, markFailed } from '../services/generationService';
import { getGenerationPresignedUrl, getUploadPresignedUrl } from '../services/archivalService';
import { getReplicateWebhookUrl } from '../config';
import type { GenerationInput } from '../services/providers/ModelProvider';
import { db } from '../db/client';
import { referenceUploads } from '../db/schema';
import { eq, inArray, and, sql } from 'drizzle-orm';

export const generationsRouter = Router();

const provider = new ReplicateProvider();

// Shared by the Seedance fallthrough and the Grok Imagine branch below.
const VALID_VIDEO_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];

interface ResolvedGenerationRequest {
  prompt: string;
  model: string;
  mediaType: 'video' | 'image' | 'avatar' | 'upscale';
  // Video-only
  durationSeconds?: number;
  resolution?: '480p' | '720p' | '1080p' | '4k';
  aspectRatio?: string;
  audioEnabled?: boolean;
  referenceImages?: string[];
  referenceVideos?: string[];
  refUploadIds?: string[];
  // Image-only
  imageAspectRatio?: string;
  imageQuality?: 'high' | 'medium' | 'low';
  // Avatar-only (DreamActor M2.0)
  avatarImage?: string;
  avatarDrivingVideo?: string;
  cutFirstSecond?: boolean;
  // Upscale-only (ByteDance Video Upscaler)
  upscalerInputVideo?: string;
  upscalerTier?: 'standard' | 'pro';
  upscalerScene?: string;
  upscalerTargetResolution?: string;
  upscalerTargetFps?: number;
  cost: number;
}

declare global {
  namespace Express {
    interface Request {
      _resolved?: ResolvedGenerationRequest;
    }
  }
}

// Issue 4 fix: client-supplied presigned reference URLs can be hours old by the time the user
// submits (uploads list hydrates from a days-old disk snapshot; @-mention library URLs are
// 1-hour TTL). Re-sign in place from the owning reference_uploads/generations row right before
// dispatch so Replicate always receives a URL it can actually fetch. `uploadIds`/`generationIds`
// are parallel arrays aligned by index to `urls` (id-or-null); entries with no id are left as the
// client-sent URL unchanged. Ownership-scoped to `userId` — never re-signs another user's media.
async function resignReferenceUrls(
  urls: string[],
  uploadIds: Array<string | null | undefined> | undefined,
  generationIds: Array<string | null | undefined> | undefined,
  userId: string,
): Promise<string[]> {
  if (urls.length === 0) return urls;
  const result = [...urls];

  const uploadEntries = urls
    .map((_, i) => ({ i, id: uploadIds?.[i] }))
    .filter((e): e is { i: number; id: string } => typeof e.id === 'string' && e.id.length > 0);
  if (uploadEntries.length > 0) {
    const rows = await db
      .select()
      .from(referenceUploads)
      .where(and(inArray(referenceUploads.id, uploadEntries.map((e) => e.id)), eq(referenceUploads.user_id, userId)));
    const rowById = Object.fromEntries(rows.map((r) => [r.id, r]));
    for (const { i, id } of uploadEntries) {
      const row = rowById[id];
      if (row) result[i] = await getUploadPresignedUrl(row.r2_key);
    }
  }

  const generationEntries = urls
    .map((_, i) => ({ i, id: generationIds?.[i] }))
    .filter((e): e is { i: number; id: string } => typeof e.id === 'string' && e.id.length > 0);
  for (const { i, id } of generationEntries) {
    const gen = await getGenerationById(id, userId);
    if (gen && gen.status === 'completed' && gen.r2_key) {
      result[i] = await getGenerationPresignedUrl(gen.r2_key);
    }
  }

  return result;
}

// Diagnostic only — host + expiry query param, never the full URL (carries the presign
// signature). Lets a prod "reference didn't apply" report be triaged from Railway logs alone.
function logReferenceUrlDiagnostics(label: string, urls: string[] | undefined): void {
  for (const url of urls ?? []) {
    try {
      const parsed = new URL(url);
      console.log(`[generations] dispatching ${label} reference host=${parsed.host} expires=${parsed.searchParams.get('X-Amz-Expires')} issued=${parsed.searchParams.get('X-Amz-Date')}`);
    } catch {
      console.log(`[generations] dispatching ${label} reference (unparseable URL)`);
    }
  }
}

// Step 1: validate + resolve duration/cost, attach cost_credits to req.body so
// creditCheckMiddleware (mounted next) can read it per its existing contract.
function prepareCost(req: Request, res: Response, next: NextFunction): void {
  const {
    prompt,
    model,
    media_type = 'video',
    // video-specific
    duration,
    resolution,
    aspect_ratio,
    audio_enabled,
    reference_images,
    reference_videos,
    reference_upload_ids,
    // image-specific
    image_aspect_ratio,
    image_quality,
    // avatar-specific (DreamActor M2.0)
    avatar_image,
    avatar_driving_video,
    cut_first_second,
    // upscale-specific (ByteDance Video Upscaler)
    source_video_url,
    processing_type,
    scene,
    target_resolution,
    target_fps,
    // shared for avatar + upscale billing (duration not known upfront)
    estimated_duration_seconds,
  } = req.body ?? {};

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'prompt is required', code: 'INVALID_PROMPT' });
    return;
  }

  if (media_type === 'avatar') {
    const avatarModel = model ?? 'bytedance/dreamactor-m2.0';
    if (!(SUPPORTED_AVATAR_MODELS as readonly string[]).includes(avatarModel)) {
      res.status(400).json({ error: `model must be one of: ${SUPPORTED_AVATAR_MODELS.join(', ')}`, code: 'INVALID_MODEL' });
      return;
    }
    if (!avatar_image || typeof avatar_image !== 'string') {
      res.status(400).json({ error: 'avatar_image (presigned URL) is required', code: 'INVALID_INPUT' });
      return;
    }
    if (!avatar_driving_video || typeof avatar_driving_video !== 'string') {
      res.status(400).json({ error: 'avatar_driving_video (presigned URL) is required', code: 'INVALID_INPUT' });
      return;
    }
    const estimatedDuration = typeof estimated_duration_seconds === 'number' && estimated_duration_seconds > 0
      ? estimated_duration_seconds : 5;
    const cost = computeDreamActorCost(estimatedDuration);
    req.body.cost_credits = cost;
    req._resolved = {
      prompt: '',
      model: avatarModel,
      mediaType: 'avatar',
      durationSeconds: estimatedDuration,
      avatarImage: avatar_image as string,
      avatarDrivingVideo: avatar_driving_video as string,
      cutFirstSecond: cut_first_second !== false,
      cost,
    };
    next();
    return;
  }

  if (media_type === 'upscale') {
    const upscalerModel = model ?? 'bytedance/video-upscaler';
    if (!(SUPPORTED_UPSCALER_MODELS as readonly string[]).includes(upscalerModel)) {
      res.status(400).json({ error: `model must be one of: ${SUPPORTED_UPSCALER_MODELS.join(', ')}`, code: 'INVALID_MODEL' });
      return;
    }
    if (!source_video_url || typeof source_video_url !== 'string') {
      res.status(400).json({ error: 'source_video_url (presigned URL of video to upscale) is required', code: 'INVALID_INPUT' });
      return;
    }
    const estimatedDuration = typeof estimated_duration_seconds === 'number' && estimated_duration_seconds > 0
      ? estimated_duration_seconds : 5;
    // Pro tier is Replicate-allowlist-only — always clamp to 'standard' server-side
    const tier: 'standard' | 'pro' = 'standard';
    const targetRes = typeof target_resolution === 'string' ? target_resolution : '720p';
    const targetFpsNum = typeof target_fps === 'number' ? target_fps : 30;
    const upscalerScene = typeof scene === 'string' ? scene : 'aigc';
    const cost = computeUpscalerCost(estimatedDuration, tier, targetRes, targetFpsNum);
    req.body.cost_credits = cost;
    req._resolved = {
      prompt: '',
      model: upscalerModel,
      mediaType: 'upscale',
      durationSeconds: estimatedDuration,
      upscalerInputVideo: source_video_url as string,
      upscalerTier: tier,
      upscalerScene: upscalerScene,
      upscalerTargetResolution: targetRes,
      upscalerTargetFps: targetFpsNum,
      cost,
    };
    next();
    return;
  }

  if (media_type === 'image') {
    // Image path — flat cost per model, no duration/resolution (T-08-03-01 mitigated below)
    const imageModel = model ?? 'black-forest-labs/flux-schnell';
    if (!(SUPPORTED_IMAGE_MODELS as readonly string[]).includes(imageModel)) {
      res.status(400).json({ error: `model must be one of: ${SUPPORTED_IMAGE_MODELS.join(', ')}`, code: 'INVALID_MODEL' });
      return;
    }
    const VALID_IMAGE_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2'];
    const imageAspectRatio = typeof image_aspect_ratio === 'string' && VALID_IMAGE_ASPECT_RATIOS.includes(image_aspect_ratio)
      ? image_aspect_ratio
      : '1:1';
    const qualityFromModel: Record<string, 'high' | 'medium' | 'low'> = {
      'openai/gpt-image-2-high':   'high',
      'openai/gpt-image-2-medium': 'medium',
      'openai/gpt-image-2-low':    'low',
    };
    const validQualities = ['high', 'medium', 'low'] as const;
    type ImageQuality = typeof validQualities[number];
    const imageQuality: ImageQuality =
      qualityFromModel[imageModel] ??
      (validQualities.includes(image_quality as ImageQuality) ? (image_quality as ImageQuality) : 'high');
    const cost = computeImageCostCredits(imageModel);

    req.body.cost_credits = cost;
    req._resolved = {
      prompt: prompt as string,
      model: imageModel,
      mediaType: 'image',
      imageAspectRatio,
      imageQuality,
      cost,
    };
    next();
    return;
  }

  // xAI Grok Imagine Video 1.5 — image-to-video, mandatory image, flat credit rate,
  // no bracket-token prompt injection (Grok takes `image` directly, not [Image1] notation).
  if (model && (SUPPORTED_GROK_MODELS as readonly string[]).includes(model)) {
    const refImages: string[] = Array.isArray(reference_images)
      ? reference_images.filter((u: unknown) => typeof u === 'string')
      : [];
    if (refImages.length === 0) {
      res.status(400).json({ error: 'This model requires a reference image.', code: 'INVALID_INPUT' });
      return;
    }
    const validResolutions = MODEL_RESOLUTIONS[model];
    if (!validResolutions?.includes(resolution)) {
      res.status(400).json({ error: `resolution must be one of: ${validResolutions?.join(', ')}`, code: 'INVALID_RESOLUTION' });
      return;
    }
    if (aspect_ratio !== undefined && !VALID_VIDEO_ASPECT_RATIOS.includes(aspect_ratio)) {
      res.status(400).json({ error: `aspect_ratio must be one of: ${VALID_VIDEO_ASPECT_RATIOS.join(', ')}`, code: 'INVALID_ASPECT_RATIO' });
      return;
    }
    let durationSeconds: number;
    try {
      durationSeconds = resolveDurationSeconds(duration);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message, code: 'INVALID_DURATION' });
      return;
    }
    const cost = computeGrokImagineCost(durationSeconds);
    req.body.cost_credits = cost;
    req._resolved = {
      prompt: prompt as string,
      model,
      mediaType: 'video',
      durationSeconds,
      resolution,
      aspectRatio: aspect_ratio ?? '16:9',
      audioEnabled: true, // always on — Grok has no audio toggle
      cost,
      referenceImages: [refImages[0]],
    };
    next();
    return;
  }

  // Video path — existing logic (UNCHANGED), T-08-03-02 mitigated: video model validated against
  // SUPPORTED_MODELS only, so a flux-* ID supplied with media_type='video' (or omitted) is rejected.
  const videoModel = model ?? 'bytedance/seedance-2.0-fast';
  if (!SUPPORTED_MODELS.includes(videoModel)) {
    res.status(400).json({ error: `model must be one of: ${SUPPORTED_MODELS.join(', ')}`, code: 'INVALID_MODEL' });
    return;
  }
  const validResolutions = MODEL_RESOLUTIONS[videoModel];
  if (!validResolutions?.includes(resolution)) {
    res.status(400).json({ error: `resolution must be one of: ${validResolutions?.join(', ') ?? '480p, 720p'}`, code: 'INVALID_RESOLUTION' });
    return;
  }

  if (aspect_ratio !== undefined && !VALID_VIDEO_ASPECT_RATIOS.includes(aspect_ratio)) {
    res.status(400).json({ error: `aspect_ratio must be one of: ${VALID_VIDEO_ASPECT_RATIOS.join(', ')}`, code: 'INVALID_ASPECT_RATIO' });
    return;
  }

  let durationSeconds: number;
  try {
    durationSeconds = resolveDurationSeconds(duration);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message, code: 'INVALID_DURATION' });
    return;
  }

  // Normalize reference arrays — filter to string-only entries (client may send null/undefined elements)
  const refImages: string[] = Array.isArray(reference_images)
    ? reference_images.filter((u: unknown) => typeof u === 'string')
    : [];
  const refVideos: string[] = Array.isArray(reference_videos)
    ? reference_videos.filter((u: unknown) => typeof u === 'string')
    : [];

  // Auto-append [ImageN]/[VideoN] tokens — Seedance 2.0 uses bracket notation per Replicate docs.
  // Replicate ignores reference arrays if the corresponding token is absent from the prompt.
  // Client inserts tokens directly; this fallback covers regen/remix flows that pre-date client-side tokens.
  let finalPrompt = prompt as string;
  for (let i = 0; i < refImages.length; i++) {
    const token = `[Image${i + 1}]`;
    if (!finalPrompt.includes(token)) finalPrompt += ` ${token}`;
  }
  for (let i = 0; i < refVideos.length; i++) {
    const token = `[Video${i + 1}]`;
    if (!finalPrompt.includes(token)) finalPrompt += ` ${token}`;
  }

  // Use videoIn rate when video references are present (GEN-03, T-07-04-03: flag is set server-side)
  const cost = computeCostCredits({
    durationSeconds,
    resolution,
    model: videoModel as SupportedModel,
    hasVideoReference: refVideos.length > 0,
  });

  const refUploadIds: string[] = Array.isArray(reference_upload_ids)
    ? reference_upload_ids.filter((id: unknown) => typeof id === 'string')
    : [];

  req.body.cost_credits = cost;
  req._resolved = {
    prompt: finalPrompt,
    model: videoModel,
    mediaType: 'video',
    durationSeconds,
    resolution,
    aspectRatio: aspect_ratio ?? '16:9',
    audioEnabled: Boolean(audio_enabled),
    cost,
    referenceImages: refImages.length > 0 ? refImages : undefined,
    referenceVideos: refVideos.length > 0 ? refVideos : undefined,
    refUploadIds: refUploadIds.length > 0 ? refUploadIds : undefined,
  };
  next();
}

generationsRouter.post('/', promptModerationMiddleware, prepareCost, creditCheckMiddleware, async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const resolved = req._resolved as ResolvedGenerationRequest;

  try {
    // Re-sign reference URLs from their owning upload/generation row (Issue 4: client-sent
    // presigned URLs can be stale by submit time). Parallel id arrays are aligned by index to
    // reference_images/reference_videos as sent by the client — order/count must match resolved.
    const refImageUploadIds = Array.isArray(req.body?.reference_image_upload_ids)
      ? (req.body.reference_image_upload_ids as Array<string | null>) : undefined;
    const refVideoUploadIds = Array.isArray(req.body?.reference_video_upload_ids)
      ? (req.body.reference_video_upload_ids as Array<string | null>) : undefined;
    const refImageGenerationIds = Array.isArray(req.body?.reference_image_generation_ids)
      ? (req.body.reference_image_generation_ids as Array<string | null>) : undefined;
    const refVideoGenerationIds = Array.isArray(req.body?.reference_video_generation_ids)
      ? (req.body.reference_video_generation_ids as Array<string | null>) : undefined;

    if (resolved.referenceImages?.length) {
      resolved.referenceImages = await resignReferenceUrls(
        resolved.referenceImages, refImageUploadIds, refImageGenerationIds, req.user.dbUserId,
      );
    }
    if (resolved.referenceVideos?.length) {
      resolved.referenceVideos = await resignReferenceUrls(
        resolved.referenceVideos, refVideoUploadIds, refVideoGenerationIds, req.user.dbUserId,
      );
    }

    const params =
      resolved.mediaType === 'image'
        ? { aspect_ratio: resolved.imageAspectRatio ?? '1:1' }
        : resolved.mediaType === 'avatar'
        ? { avatar_image: resolved.avatarImage, avatar_driving_video: resolved.avatarDrivingVideo, estimated_duration: resolved.durationSeconds }
        : resolved.mediaType === 'upscale'
        ? { source_video_url: resolved.upscalerInputVideo, processing_type: resolved.upscalerTier, scene: resolved.upscalerScene, target_resolution: resolved.upscalerTargetResolution, target_fps: resolved.upscalerTargetFps, estimated_duration: resolved.durationSeconds }
        : {
            resolution: resolved.resolution,
            duration: resolved.durationSeconds,
            aspect_ratio: resolved.aspectRatio,
            audio_enabled: resolved.audioEnabled,
            has_reference: ((resolved.referenceImages?.length ?? 0) + (resolved.referenceVideos?.length ?? 0)) > 0,
            ref_upload_ids: resolved.refUploadIds ?? [],
          };

    const { id: generationId } = await createGeneration({
      user_id: req.user.dbUserId,
      model: resolved.model,
      status: 'pending',
      prompt: resolved.prompt || null,
      params,
      cost_credits: resolved.cost,
      media_type: resolved.mediaType,
    });

    const webhookUrl = getReplicateWebhookUrl();
    console.log(`[generations] webhookUrl="${webhookUrl}"`);
    const input: GenerationInput = {
      prompt: resolved.prompt,
      model: resolved.model,
      mediaType: resolved.mediaType,
      // Video-only
      durationSeconds: resolved.durationSeconds,
      resolution: resolved.resolution,
      aspectRatio: resolved.aspectRatio,
      audioEnabled: resolved.audioEnabled,
      referenceImages: resolved.referenceImages?.length ? resolved.referenceImages : undefined,
      referenceVideos: resolved.referenceVideos?.length ? resolved.referenceVideos : undefined,
      // Image-only
      imageAspectRatio: resolved.imageAspectRatio,
      imageQuality: resolved.imageQuality,
      // Avatar-only
      avatarImage: resolved.avatarImage,
      avatarDrivingVideo: resolved.avatarDrivingVideo,
      cutFirstSecond: resolved.cutFirstSecond,
      // Upscale-only
      upscalerInputVideo: resolved.upscalerInputVideo,
      upscalerTier: resolved.upscalerTier,
      upscalerScene: resolved.upscalerScene as GenerationInput['upscalerScene'],
      upscalerTargetResolution: resolved.upscalerTargetResolution,
      upscalerTargetFps: resolved.upscalerTargetFps as GenerationInput['upscalerTargetFps'],
    };

    logReferenceUrlDiagnostics('image', input.referenceImages);
    logReferenceUrlDiagnostics('video', input.referenceVideos);

    let providerPredictionId: string;
    try {
      ({ providerPredictionId } = await provider.dispatch(input, webhookUrl));
    } catch (dispatchError) {
      const errMsg = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
      const isRateLimit = errMsg.includes('429') || errMsg.toLowerCase().includes('throttled');
      console.error(`[generations] Dispatch failed (model=${resolved.model}): ${errMsg}`);
      await markFailed(generationId, classifyFailureReason(errMsg));
      await refundCredits(req.user.dbUserId, resolved.cost, `dispatch-failure-${generationId}`);
      res.status(502).json({
        error: isRateLimit
          ? 'Generation service is busy. Please try again in a moment. Credits have been refunded.'
          : 'Generation provider unavailable. Credits have been refunded.',
      });
      return;
    }

    // Perf: respond as soon as dispatch succeeds instead of waiting on one more DB round trip.
    // Safe because the reaper only reaps 'pending' rows older than 5 minutes (reaperWorker.ts) —
    // this row is 'pending' with a NULL replicate_prediction_id for milliseconds, not minutes,
    // and Replicate's webhook can't arrive before the generation actually finishes running.
    res.status(200).json({ generation_id: generationId, status: 'processing' });
    try {
      await attachPredictionId(generationId, providerPredictionId);
    } catch (attachError) {
      // Response already sent — log only. The reaper's stalled-job pass (processing >30min)
      // or orphaned-job pass would eventually reconcile a generation stuck without a prediction
      // id; in practice this write essentially never fails since dispatch just succeeded.
      console.error(`[generations] attachPredictionId failed for ${generationId}:`, attachError);
    }
  } catch (error) {
    console.error('[generations] Error dispatching generation:', error);
    res.status(500).json({ error: 'Failed to dispatch generation' });
  }
});

// GET /api/generations — cursor-paginated list (GAL-01, D-31)
// Returns newest-first; completed items include video_url (24-hr presigned). Never returns quarantined/deleted.
// SECURITY: user_id scoped inside listGenerations (T-07-02-01 mitigated)
generationsRouter.get('/', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  try {
    const { cursor: cursorStr, limit: limitStr } = req.query;
    let cursor: { createdAt: Date; id: string } | undefined;
    if (typeof cursorStr === 'string') {
      const [createdAtStr, id] = cursorStr.split('__');
      if (createdAtStr && id) cursor = { createdAt: new Date(createdAtStr), id };
    }
    const limit = Math.min(Number(limitStr) || 20, 50);
    const items = await listGenerations(req.user.dbUserId, cursor, limit);

    // Pre-fetch all reference upload rows needed across all items in one query
    const allRefIds = items.flatMap((item) => {
      const p = item.params as Record<string, unknown> | null;
      const ids = p?.ref_upload_ids;
      return Array.isArray(ids) ? ids as string[] : [];
    });
    const refUploadRows = allRefIds.length > 0
      ? await db.select().from(referenceUploads).where(inArray(referenceUploads.id, allRefIds))
      : [];
    const refUploadMap = Object.fromEntries(refUploadRows.map((r) => [r.id, r]));

    const enriched = await Promise.all(
      items.map(async (item) => {
        const p = item.params as Record<string, unknown> | null;
        const refIds: string[] = Array.isArray(p?.ref_upload_ids) ? p!.ref_upload_ids as string[] : [];
        const referenceUrls = await Promise.all(
          refIds
            .filter((id) => refUploadMap[id])
            .map(async (id) => {
              const row = refUploadMap[id];
              const url = await getUploadPresignedUrl(row.r2_key);
              return { url, isVideo: row.mime_type.startsWith('video/') };
            }),
        );
        return {
          ...item,
          video_url: item.status === 'completed' && item.r2_key
            ? await getGenerationPresignedUrl(item.r2_key)
            : null,
          reference_urls: referenceUrls.length > 0 ? referenceUrls : null,
        };
      }),
    );
    const last = enriched[enriched.length - 1];
    const nextCursor = enriched.length === limit && last
      ? `${last.created_at instanceof Date ? last.created_at.toISOString() : last.created_at}__${last.id}`
      : null;
    res.status(200).json({ items: enriched, nextCursor });
  } catch (err) {
    console.error('[generations] Error listing generations:', err);
    res.status(500).json({ error: 'Failed to list generations' });
  }
});

// GET /api/generations/:id — single generation with presigned URL (GAL-05, D-32)
// SECURITY: getGenerationById filters WHERE user_id = dbUserId (T-07-02-01 mitigated)
generationsRouter.get('/:id', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  try {
    const item = await getGenerationById(req.params.id as string, req.user.dbUserId);
    if (!item) { res.status(404).json({ error: 'Not found' }); return; }
    const video_url = item.status === 'completed' && item.r2_key
      ? await getGenerationPresignedUrl(item.r2_key)
      : null;
    const p = item.params as Record<string, unknown> | null;
    const refIds: string[] = Array.isArray(p?.ref_upload_ids) ? p!.ref_upload_ids as string[] : [];
    const referenceRows = refIds.length > 0
      ? await db.select().from(referenceUploads).where(inArray(referenceUploads.id, refIds))
      : [];
    const reference_urls = referenceRows.length > 0
      ? await Promise.all(referenceRows.map(async (r) => ({
          url: await getUploadPresignedUrl(r.r2_key),
          isVideo: r.mime_type.startsWith('video/'),
        })))
      : null;
    res.status(200).json({ ...item, video_url, reference_urls });
  } catch (err) {
    console.error('[generations] Error fetching generation:', err);
    res.status(500).json({ error: 'Failed to fetch generation' });
  }
});

// DELETE /api/generations/:id — soft-delete (GAL-06, D-37)
// SECURITY: softDeleteGeneration WHERE clause includes user_id guard (T-07-02-02 mitigated)
generationsRouter.delete('/:id', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  try {
    const deleted = await softDeleteGeneration(req.params.id as string, req.user.dbUserId);
    if (!deleted) { res.status(404).json({ error: 'Not found or not authorized' }); return; }
    res.status(204).send();
  } catch (err) {
    console.error('[generations] Error deleting generation:', err);
    res.status(500).json({ error: 'Failed to delete generation' });
  }
});
