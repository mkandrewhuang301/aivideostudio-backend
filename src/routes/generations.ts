// src/routes/generations.ts
// POST /api/generations — validates request, resolves duration (CLAUDE.md Rule 7: never -1),
// computes cost, gates on credits (creditCheckMiddleware), creates the generation row,
// dispatches via the ModelProvider abstraction (CLAUDE.md Rule 6: no Replicate code here directly
// beyond instantiating ReplicateProvider — all calls go through the interface).

import { Router, Request, Response, NextFunction } from 'express';
import { creditCheckMiddleware } from '../middleware/creditCheck';
import { promptModerationMiddleware } from '../middleware/promptModeration';
import { celebrityCheckMiddleware } from '../middleware/celebrityCheck';
import { inputMediaGate } from '../middleware/inputMediaGate';
import { presetResolver } from '../middleware/presetResolver';
import {
  resolveDurationSeconds,
  computeCostCredits,
  computeImageCostCredits,
  computeDreamActorCost,
  computeUpscalerCost,
  computeImageUpscaleCost,
  computeGrokImagineCost,
  computeHappyHorseCost,
  resolveHappyHorseDuration,
  computeCharacterReplaceCost,
  computeCharacterReplaceProCost,
  computeFaceswapCost,
  computeChainCost,
  createGeneration,
  attachPredictionId,
  listGenerations,
  getGenerationById,
  softDeleteGeneration,
  setGenerationFavorite,
  SUPPORTED_MODELS,
  MODEL_RESOLUTIONS,
  SUPPORTED_IMAGE_MODELS,
  SUPPORTED_AVATAR_MODELS,
  SUPPORTED_UPSCALER_MODELS,
  SUPPORTED_IMAGE_UPSCALE_MODELS,
  SUPPORTED_GROK_MODELS,
  SUPPORTED_HAPPYHORSE_MODELS,
  SUPPORTED_CHARACTER_REPLACE_MODELS,
  SUPPORTED_FACESWAP_MODELS,
  type SupportedModel,
} from '../services/generationService';
import { ReplicateProvider } from '../services/providers/ReplicateProvider';
import { refundCredits } from '../services/creditService';
import { classifyFailureReason, markFailed } from '../services/generationService';
import { getGenerationPresignedUrl, getUploadPresignedUrl } from '../services/archivalService';
import { openaiGenerationQueue } from '../queue/openaiGenerationQueue';
import { chainGenerationQueue } from '../queue/chainGenerationQueue';
import { influencerProQueue } from '../queue/influencerProQueue';
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
  mediaType: 'video' | 'image' | 'avatar' | 'upscale' | 'character_replace' | 'faceswap' | 'chain';
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
  // Magic Editor-only (09.2-08) — presence routes the image branch through the OpenAI-direct
  // inline mask-edit path instead of Replicate dispatch. Source image lives in referenceImages[0].
  maskUrl?: string;
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
  // Upscale-only (Recraft Crisp Upscale — image path; distinct from the video upscaler above)
  upscalerInputImage?: string;
  // Character-replace-only (Wan 2.2 Animate Replace — AI Influencer, D-23; Marlon Motion
  // Transfer bundled-driver, 09.6 D-03/D-04)
  characterReplaceVideo?: string;
  characterReplaceImage?: string;
  characterReplaceMergeAudio?: boolean;
  // AI Influencer Pro tier only — presence routes dispatch to influencerProQueue's 3-step
  // pipeline (frame extract -> Wan 2.7 composite -> Kling v3 Motion Control) instead of the
  // inline Wan 2.2 Animate Replace dispatch below. Undefined for Standard tier and every other
  // character_replace preset (Marlon).
  characterReplaceQuality?: 'pro';
  // Faceswap-only (inline OpenAI gpt-image-2, 09.2-12)
  swapImage?: string;
  targetImage?: string;
  hairSource?: 'target' | 'user';
  // Chain-only (09.6, D-01/D-05) — resolved user photo slot(s) for the chain's image_stage
  // (UVU's sole 9.6 consumer). No dispatch consumer yet (Plan 05 adds the worker).
  chainInputImages?: string[];
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
    // upscale-specific (Recraft Crisp Upscale — image path)
    upscale_image_url,
    // character-replace-specific (Wan 2.2 Animate Replace — AI Influencer, D-23)
    character_replace_video,
    character_replace_image,
    character_replace_quality,
    // faceswap-specific (inline OpenAI gpt-image-2, 09.2-12; formerly Easel via Replicate, 09.2-07)
    swap_image,
    target_image,
    hair_source,
    // chain-specific (09.6, D-01/D-05) — set by presetResolver's 'chain' case; never client-supplied
    chain_input_images,
    __chain_def,
    // shared for avatar + upscale + character-replace billing (duration not known upfront)
    estimated_duration_seconds,
  } = req.body ?? {};

  // avatar/upscale/character-replace/faceswap/chain branches take no text prompt (D-16/D-22/D-23
  // presets: motion-transfer, enhancer-video, enhancer-image, ai-influencer, faceswap, chain all
  // have an empty prompt_template) — only image/video/grok branches require one.
  if (media_type !== 'avatar' && media_type !== 'upscale' && media_type !== 'character_replace' && media_type !== 'faceswap' && media_type !== 'chain' && (!prompt || typeof prompt !== 'string')) {
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

  if (media_type === 'character_replace') {
    if (!character_replace_video || typeof character_replace_video !== 'string') {
      res.status(400).json({ error: 'character_replace_video (presigned URL) is required', code: 'INVALID_INPUT' });
      return;
    }
    if (!character_replace_image || typeof character_replace_image !== 'string') {
      res.status(400).json({ error: 'character_replace_image (presigned URL) is required', code: 'INVALID_INPUT' });
      return;
    }
    const estimatedDuration = typeof estimated_duration_seconds === 'number' && estimated_duration_seconds > 0
      ? estimated_duration_seconds : 5;

    // AI Influencer Pro tier (presetResolver-stamped, ai-influencer only — never client-picked
    // directly): bypasses the Wan 2.2 Animate Replace model entirely, billed via the combined
    // Kling-std-per-second + Wan-2.7-flat cost (Kling 'std', not 'pro' — this preset's "Pro"
    // tier is the compositing pipeline itself, unrelated to Kling's own quality flag). Model is
    // stamped as the Kling id purely for
    // accurate DB/regen display — it's never validated against SUPPORTED_CHARACTER_REPLACE_MODELS
    // (that whitelist is Wan-only) since it's never client-supplied for this branch.
    if (character_replace_quality === 'pro') {
      const cost = computeCharacterReplaceProCost(estimatedDuration);
      req.body.cost_credits = cost;
      req._resolved = {
        prompt: '',
        model: 'kwaivgi/kling-v3-motion-control',
        mediaType: 'character_replace',
        durationSeconds: estimatedDuration,
        characterReplaceVideo: character_replace_video as string,
        characterReplaceImage: character_replace_image as string,
        characterReplaceQuality: 'pro',
        cost,
      };
      next();
      return;
    }

    const replaceModel = model ?? 'wan-video/wan-2.2-animate-replace';
    if (!(SUPPORTED_CHARACTER_REPLACE_MODELS as readonly string[]).includes(replaceModel)) {
      res.status(400).json({ error: `model must be one of: ${SUPPORTED_CHARACTER_REPLACE_MODELS.join(', ')}`, code: 'INVALID_MODEL' });
      return;
    }
    const cost = computeCharacterReplaceCost(estimatedDuration);
    req.body.cost_credits = cost;
    // 09.6 D-04: presets with a mux postprocess (Marlon) mux a separate default audio track after
    // dispatch, so the raw Wan output must be silent — a clean Plan-01 silent master. ai-influencer
    // (no postprocess) keeps merge_audio unset, preserving its existing driver-audio behavior.
    const characterReplaceMergeAudio = req._preset?.postprocess?.op === 'mux' ? false : undefined;
    req._resolved = {
      prompt: '',
      model: replaceModel,
      mediaType: 'character_replace',
      durationSeconds: estimatedDuration,
      characterReplaceVideo: character_replace_video as string,
      characterReplaceImage: character_replace_image as string,
      characterReplaceMergeAudio,
      cost,
    };
    next();
    return;
  }

  if (media_type === 'faceswap') {
    const faceswapModel = model ?? 'openai/gpt-image-2-medium';
    if (!(SUPPORTED_FACESWAP_MODELS as readonly string[]).includes(faceswapModel)) {
      res.status(400).json({ error: `model must be one of: ${SUPPORTED_FACESWAP_MODELS.join(', ')}`, code: 'INVALID_MODEL' });
      return;
    }
    if (!swap_image || typeof swap_image !== 'string') {
      res.status(400).json({ error: 'swap_image (presigned URL) is required', code: 'INVALID_INPUT' });
      return;
    }
    if (!target_image || typeof target_image !== 'string') {
      res.status(400).json({ error: 'target_image (presigned URL) is required', code: 'INVALID_INPUT' });
      return;
    }
    const cost = computeFaceswapCost();
    req.body.cost_credits = cost;
    req._resolved = {
      prompt: '',
      model: faceswapModel,
      mediaType: 'faceswap',
      swapImage: swap_image as string,
      targetImage: target_image as string,
      hairSource: hair_source === 'user' ? 'user' : 'target',
      cost,
    };
    next();
    return;
  }

  if (media_type === 'upscale') {
    const upscalerModel = model ?? 'bytedance/video-upscaler';

    if ((SUPPORTED_IMAGE_UPSCALE_MODELS as readonly string[]).includes(upscalerModel)) {
      // Recraft Crisp Upscale (Enhancer — image path): flat per-image cost, single `image` field —
      // distinct from the per-second ByteDance video upscaler below (T-09.1 enhancer-image preset).
      if (!upscale_image_url || typeof upscale_image_url !== 'string') {
        res.status(400).json({ error: 'upscale_image_url (presigned URL of image to upscale) is required', code: 'INVALID_INPUT' });
        return;
      }
      const cost = computeImageUpscaleCost();
      req.body.cost_credits = cost;
      req._resolved = {
        prompt: '',
        model: upscalerModel,
        mediaType: 'upscale',
        upscalerInputImage: upscale_image_url as string,
        cost,
      };
      next();
      return;
    }

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

    // Reference images (e.g. try-on/hairstyle/anime-yourself/polaroid presets) — GPT-Image-2's
    // input_images. Not previously read by this branch; ReplicateProvider already maps
    // referenceImages -> input_images for gpt-image-2 models (verified in ReplicateProvider.ts).
    const refImages: string[] = Array.isArray(reference_images)
      ? reference_images.filter((u: unknown) => typeof u === 'string')
      : [];

    req.body.cost_credits = cost;
    req._resolved = {
      prompt: prompt as string,
      model: imageModel,
      mediaType: 'image',
      imageAspectRatio,
      imageQuality,
      cost,
      referenceImages: refImages.length > 0 ? refImages : undefined,
      // Magic Editor (09.2-08): presetResolver sets req.body.mask_url when preset_id ===
      // 'magic-editor' — its presence (not the model id) is what routes dispatch inline below.
      ...(typeof req.body?.mask_url === 'string' ? { maskUrl: req.body.mask_url } : {}),
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

  // Alibaba HappyHorse 1.1 — text-to-video (0 images) OR single-image image-to-video (1 image).
  // Per-resolution pricing, native always-on audio (no toggle), duration 3–15. Uses an `images`
  // array (no [ImageN] token injection). v1: reject 2+ images (2–9 reference-to-video deferred).
  // NOTE: the model's README marks `prompt` OPTIONAL for i2v, but we INTENTIONALLY keep it required
  // (via the shared media_type='video' prompt check above) — every generation must carry a prompt so
  // the planned LLM prompt-interceptor has a consistent input to enhance. Do NOT relax this to match
  // the README without also handling the empty-prompt case in the interceptor contract.
  if (model && (SUPPORTED_HAPPYHORSE_MODELS as readonly string[]).includes(model)) {
    const refImages: string[] = Array.isArray(reference_images)
      ? reference_images.filter((u: unknown) => typeof u === 'string')
      : [];
    if (refImages.length > 1) {
      res.status(400).json({ error: 'This model accepts at most one reference image in v1.', code: 'INVALID_INPUT' });
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
      durationSeconds = resolveHappyHorseDuration(duration);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message, code: 'INVALID_DURATION' });
      return;
    }
    const cost = computeHappyHorseCost(durationSeconds, resolution);
    req.body.cost_credits = cost;
    req._resolved = {
      prompt: prompt as string,
      model,
      mediaType: 'video',
      durationSeconds,
      resolution,
      aspectRatio: aspect_ratio ?? '16:9',
      audioEnabled: true, // native audio baked in — no toggle
      cost,
      referenceImages: refImages.length > 0 ? [refImages[0]] : undefined,
    };
    next();
    return;
  }

  // Chained-job primitive (09.6, D-01/D-05) — sole 9.6 consumer is You vs You (UVU). Billed via
  // the cents-rule combined cost (image-stage keyframes + HappyHorse animate); the client's cost/
  // duration values are never read (T-09.6-09) — cost comes entirely from the server chain
  // descriptor (__chain_def, stamped by presetResolver's 'chain' case). No dispatch yet (Plan 05).
  if (media_type === 'chain') {
    const chainInputImages: string[] = Array.isArray(chain_input_images)
      ? chain_input_images.filter((u: unknown) => typeof u === 'string')
      : [];
    if (chainInputImages.length === 0) {
      res.status(400).json({ error: 'chain_input_images is required', code: 'INVALID_INPUT' });
      return;
    }
    const chainDef = __chain_def as NonNullable<import('../config/presets').PresetDef['chain']> | undefined;
    if (!chainDef) {
      res.status(400).json({ error: 'Missing chain descriptor', code: 'INVALID_INPUT' });
      return;
    }
    let animateDuration: number;
    try {
      animateDuration = resolveHappyHorseDuration(chainDef.animate_stage.duration);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message, code: 'INVALID_DURATION' });
      return;
    }
    const clampedChainDef = { ...chainDef, animate_stage: { ...chainDef.animate_stage, duration: animateDuration } };
    const cost = computeChainCost(clampedChainDef);
    req.body.cost_credits = cost;
    req._resolved = {
      prompt: '',
      model: clampedChainDef.animate_stage.model,
      mediaType: 'chain',
      chainInputImages,
      cost,
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

generationsRouter.post('/', promptModerationMiddleware, presetResolver, prepareCost, celebrityCheckMiddleware, inputMediaGate, creditCheckMiddleware, async (req: Request, res: Response) => {
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
        : resolved.mediaType === 'character_replace'
        ? { character_replace_video: resolved.characterReplaceVideo, character_replace_image: resolved.characterReplaceImage, estimated_duration: resolved.durationSeconds }
        : resolved.mediaType === 'faceswap'
        ? { swap_image: resolved.swapImage, target_image: resolved.targetImage, hair_source: resolved.hairSource }
        : resolved.mediaType === 'upscale'
        ? (resolved.upscalerInputImage
            ? { upscale_image_url: resolved.upscalerInputImage }
            : { source_video_url: resolved.upscalerInputVideo, processing_type: resolved.upscalerTier, scene: resolved.upscalerScene, target_resolution: resolved.upscalerTargetResolution, target_fps: resolved.upscalerTargetFps, estimated_duration: resolved.durationSeconds })
        : {
            resolution: resolved.resolution,
            duration: resolved.durationSeconds,
            aspect_ratio: resolved.aspectRatio,
            audio_enabled: resolved.audioEnabled,
            has_reference: ((resolved.referenceImages?.length ?? 0) + (resolved.referenceVideos?.length ?? 0)) > 0,
            ref_upload_ids: resolved.refUploadIds ?? [],
          };

    // Stamp preset_id + preset_input_upload_ids (set by presetResolver) onto the row — needed for
    // the client's preset-badged card rendering + Remix reopen (D-11), never overwrites the
    // media-type-specific params computed above.
    const presetParams = req._preset
      ? {
          preset_id: req._preset.preset_id,
          preset_input_upload_ids: req._preset.input_upload_ids,
          // 09.3-05: stamps the ffmpeg post-process op (mux/concat) onto the generation row when
          // the resolved preset declares one — read by the webhook to enqueue ffmpegWorker instead
          // of marking the generation complete immediately.
          ...(req._preset.postprocess ? { postprocess: req._preset.postprocess } : {}),
          // 09.6 D-01/D-05/T-09.6-13: server-only chain descriptor (image_stage prompts +
          // animate_stage config) for the chained-job primitive (UVU). Stamped so the worker's
          // enqueue below can be reconstructed from the row if ever needed for debugging — NEVER
          // reaches the client: presetSafeSerialization strips every preset row's params down to
          // just preset_id + preset_input_upload_ids regardless of what else is stored here.
          ...(req.body.__chain_def ? { chain: req.body.__chain_def } : {}),
        }
      : {};
    // D-02: presets are always auto-routed (never trust the client to claim an explicit pick on a
    // preset row); freeform honors the client's flag, defaulting to false so the try-Seedance ->
    // Grok fallback (webhooks/replicate.ts) applies unless the user explicitly chose a model.
    const modelExplicitlyPicked = req._preset
      ? false
      : Boolean(req.body?.model_explicitly_picked);
    const rowParams = { ...params, ...presetParams, model_explicitly_picked: modelExplicitlyPicked };

    const { id: generationId } = await createGeneration({
      user_id: req.user.dbUserId,
      model: resolved.model,
      status: 'pending',
      prompt: resolved.prompt || null,
      params: rowParams,
      cost_credits: resolved.cost,
      media_type: resolved.mediaType,
    });

    // Chained-job primitive (09.6, D-01/D-05, T-09.6-11/T-09.6-12): the SOLE 9.6 consumer is You
    // vs You (UVU). Credits are already deducted (creditCheckMiddleware, mounted before this
    // handler) — this ONLY enqueues the chain job (Stage1 keyframes -> Stage2 HappyHorse, run in
    // chainGenerationWorker.ts) and returns 'processing' immediately. There is no inline dispatch
    // path for 'chain' — Stage1's replicate.run() call alone can take many seconds, well past the
    // client's HTTP timeout, same rationale as the Magic Editor/faceswap async conversions below.
    if (resolved.mediaType === 'chain') {
      const chainDef = req.body.__chain_def as
        | { image_stage: { model: string; quality: 'high' | 'medium' | 'low'; prompts: string[] };
            animate_stage: { model: string; resolution: '720p' | '1080p'; duration: number; aspect_ratio: string; prompt_template: string } }
        | undefined;
      try {
        if (!chainDef) throw new Error('Missing chain descriptor');
        await chainGenerationQueue.add('generate', {
          generationId,
          userId: req.user.dbUserId,
          cost: resolved.cost,
          userPhotoUrls: resolved.chainInputImages!,
          imageStage: chainDef.image_stage,
          animateStage: chainDef.animate_stage,
        });
      } catch (err) {
        console.error(`[generations] Failed to enqueue chain job for ${generationId}:`, err);
        await markFailed(generationId, 'generic_error');
        await refundCredits(req.user.dbUserId, resolved.cost, `dispatch-failure-${generationId}`);
        res.status(502).json({ error: 'Generation service unavailable. Credits have been refunded.' });
        return;
      }

      res.status(200).json({ generation_id: generationId, status: 'processing' });
      return;
    }

    // AI Influencer Pro tier (character_replace_quality: 'pro'): same async-enqueue shape as the
    // 'chain' branch above — credits are already deducted (creditCheckMiddleware), this only
    // enqueues influencerProWorker.ts's 3-step pipeline (frame extract -> Wan 2.7 composite ->
    // Kling v3 Motion Control) and returns 'processing' immediately. No inline dispatch path here:
    // the frame extract + Wan 2.7 composite calls alone can take many seconds, well past the
    // client's HTTP timeout (same rationale as Magic Editor/faceswap below).
    if (resolved.mediaType === 'character_replace' && resolved.characterReplaceQuality === 'pro') {
      try {
        await influencerProQueue.add('generate', {
          generationId,
          userId: req.user.dbUserId,
          cost: resolved.cost,
          characterImageUrl: resolved.characterReplaceImage!,
          sourceVideoUrl: resolved.characterReplaceVideo!,
        });
      } catch (err) {
        console.error(`[generations] Failed to enqueue AI Influencer Pro job for ${generationId}:`, err);
        await markFailed(generationId, 'generic_error');
        await refundCredits(req.user.dbUserId, resolved.cost, `dispatch-failure-${generationId}`);
        res.status(502).json({ error: 'Generation service unavailable. Credits have been refunded.' });
        return;
      }

      res.status(200).json({ generation_id: generationId, status: 'processing' });
      return;
    }

    // Magic Editor (SC4, 09.2-08): OpenAI-direct mask edit. D-C (gap closure, 09.2-13): this used
    // to run the OpenAI call SYNCHRONOUSLY in-request — gpt-image-2 edits take ~47s, well past
    // the client's HTTP timeout, so the app showed "couldn't complete" even though the backend
    // succeeded. Now the row is created 'pending' above and this ENQUEUES the OpenAI work onto
    // openaiGenerationWorker.ts (background) and returns 'processing' immediately, exactly like
    // the video dispatch path below — the client polls via the existing GET /api/generations
    // machinery. Only mask edits take this branch — plain gpt-image-2 presets (hairstyle/anime/
    // polaroid/clothes-swap) have no resolved.maskUrl and fall through to the normal Replicate
    // dispatch below, unchanged.
    if (resolved.maskUrl && resolved.mediaType === 'image') {
      try {
        await openaiGenerationQueue.add('generate', {
          kind: 'magic-editor',
          generationId,
          userId: req.user.dbUserId,
          cost: resolved.cost,
          sourceImage: resolved.referenceImages![0]!,
          maskUrl: resolved.maskUrl,
          prompt: resolved.prompt,
        });
      } catch (err) {
        console.error(`[generations] Failed to enqueue Magic Editor job for ${generationId}:`, err);
        await markFailed(generationId, 'generic_error');
        await refundCredits(req.user.dbUserId, resolved.cost, `dispatch-failure-${generationId}`);
        res.status(502).json({ error: 'Edit service unavailable. Credits have been refunded.' });
        return;
      }

      res.status(200).json({ generation_id: generationId, status: 'processing' });
      return;
    }

    // Faceswap (09.2-12/09.2-13): OpenAI-direct two-image edit (gpt-image-2), re-pointed from the
    // now-dead easel/advanced-face-swap (404 on Replicate). D-C (gap closure, 09.2-13): same async
    // conversion as Magic Editor above — the row is created 'pending' above and this ENQUEUES the
    // OpenAI work onto openaiGenerationWorker.ts (background) and returns 'processing'
    // immediately. D-E: the raw uploaded face is NO LONGER deleted here — it's retained under the
    // standard 24h uploadReaperWorker so Remix can prefill it (the worker never calls
    // deleteRawFaceUploads either; see openaiGenerationWorker.ts).
    if (resolved.mediaType === 'faceswap') {
      try {
        await openaiGenerationQueue.add('generate', {
          kind: 'faceswap',
          generationId,
          userId: req.user.dbUserId,
          cost: resolved.cost,
          targetImage: resolved.targetImage!,
          faceImage: resolved.swapImage!,
        });
      } catch (err) {
        console.error(`[generations] Failed to enqueue faceswap job for ${generationId}:`, err);
        await markFailed(generationId, 'generic_error');
        await refundCredits(req.user.dbUserId, resolved.cost, `dispatch-failure-${generationId}`);
        res.status(502).json({ error: 'Faceswap service unavailable. Credits have been refunded.' });
        return;
      }

      res.status(200).json({ generation_id: generationId, status: 'processing' });
      return;
    }

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
      upscalerInputImage: resolved.upscalerInputImage,
      // Character-replace-only
      characterReplaceVideo: resolved.characterReplaceVideo,
      characterReplaceImage: resolved.characterReplaceImage,
      characterReplaceMergeAudio: resolved.characterReplaceMergeAudio,
      // Faceswap-only
      swapImage: resolved.swapImage,
      targetImage: resolved.targetImage,
      hairSource: resolved.hairSource,
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

// Client-safe serialization overrides shared by the list + detail endpoints (09.2-13):
// - D-F: faceswap OUTPUT is an image — the DB row keeps media_type 'faceswap' for dispatch/gate
//   logic, but the API reports 'image' so the client renders it as a still (fixes the "renders as
//   video / never loads" bug without an app update for existing installs).
// - D-G: preset rows must never leak model/infra to the client — null the model (mirrors the
//   existing prompt:null treatment) and strip params down to just preset_id +
//   preset_input_upload_ids (drops swap_image/target_image/mask_url/hair_source + any R2 URLs).
function presetSafeSerialization(item: {
  media_type: string;
  model: string | null;
  params: unknown;
}): { media_type: string; model: string | null; params: unknown } {
  const p = (item.params ?? null) as Record<string, unknown> | null;
  const isPreset = Boolean(p?.preset_id);
  return {
    media_type: item.media_type === 'faceswap' ? 'image' : item.media_type,
    model: isPreset ? null : item.model,
    params: isPreset
      ? { preset_id: p!.preset_id, preset_input_upload_ids: p!.preset_input_upload_ids ?? [] }
      : item.params,
  };
}

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
          // D-11/SC3/T-09.1-03: the expanded server template lives in this column for preset
          // rows — never let it reach the client. params.preset_id/preset_input_upload_ids are
          // retained (needed for the badge + Remix reopen).
          prompt: p?.preset_id ? null : item.prompt,
          // D-F (faceswap→image) + D-G (null model + strip params for preset rows). Spread AFTER
          // ...item so these override the raw DB values.
          ...presetSafeSerialization(item),
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
    // D-11/SC3/T-09.1-03: null the expanded template for preset rows; params.preset_id retained.
    const prompt = p?.preset_id ? null : item.prompt;
    // D-F (faceswap→image) + D-G (null model + strip params for preset rows). Spread AFTER ...item.
    res.status(200).json({ ...item, prompt, ...presetSafeSerialization(item), video_url, reference_urls });
  } catch (err) {
    console.error('[generations] Error fetching generation:', err);
    res.status(500).json({ error: 'Failed to fetch generation' });
  }
});

// PATCH /api/generations/:id/favorite — toggle favorite flag (FAV-01)
// SECURITY: setGenerationFavorite WHERE clause includes user_id guard (IDOR mitigated)
generationsRouter.patch('/:id/favorite', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const isFavorite = req.body?.is_favorite;
  if (typeof isFavorite !== 'boolean') {
    res.status(400).json({ error: 'is_favorite (boolean) is required', code: 'INVALID_INPUT' });
    return;
  }
  try {
    const ok = await setGenerationFavorite(req.params.id as string, req.user.dbUserId, isFavorite);
    if (!ok) { res.status(404).json({ error: 'Not found or not authorized' }); return; }
    res.status(204).send();
  } catch (err) {
    console.error('[generations] Error setting favorite:', err);
    res.status(500).json({ error: 'Failed to update favorite' });
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
