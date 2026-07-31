// src/routes/prompt.ts
// LLM prompt-intelligence endpoints (mounted at /api/prompt behind auth + banCheck):
//   POST /enhance    — { prompt, mode?: 'prompt'|'script', preset_id? }        → { prompt }
//   POST /from-image — { generation_id? | upload_id?, preset_id?, hint? }      → { prompt }
//   POST /from-video — { generation_id? | upload_id?, hint? }                  → { prompt }
//
// from-video (2026-07-25; next-shot flip 2026-07-27) is the NEXT-SHOT GUIDE: Gemini watches
// the reference clip and writes one grounded prompt for a natural CUT to a new scene after it
// (subject/world/ambience carried from the final moments → new action, new framing — never a
// seamless resume, which glitches on Seedance Mini). It shapes what the user TYPES; the
// shape-neutral dispatch interceptor (enhanceForDispatch) faithfully enriches whatever
// finally submits, continuation or cut. Results are
// Redis-cached 30min keyed by video id + hint so re-taps are instant; the endpoint is on-demand
// only (no prefetch — cost lands exclusively on actual taps, ~$0.001/read after 480p downscale).
//
// All three are FREE (no credit deduction — gpt-5-mini/gemini-flash cost fractions of a cent)
// and fail loud (502 llm_unavailable) rather than echoing input back. Per-preset behavior comes
// from PresetDef.prompt_intelligence (SERVER-ONLY registry config) keyed by the optional
// preset_id.
//
// SECURITY:
// - from-image/from-video NEVER accept a client-supplied URL — only a generation_id/upload_id,
//   resolved to a presigned R2 URL server-side with an ownership (IDOR) guard. Accepting raw
//   URLs would be an SSRF hole.
// - /enhance input runs through the same two-layer prompt moderation as POST /api/generations;
//   from-image/from-video `hint` runs through isPromptFlagged directly.
// - Quarantined/incomplete generations are never presigned (mirrors the delivery gate posture).

import { createHash } from 'node:crypto';
import { Router, Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { generations, referenceUploads } from '../db/schema';
import { redis } from '../redis/client';
import { getGenerationPresignedUrl, getUploadPresignedUrl } from '../services/archivalService';
import { isPromptFlagged, promptModerationMiddleware } from '../middleware/promptModeration';
import {
  enhancePrompt,
  promptFromImage,
  PromptIntelligenceError,
  type EnhanceMode,
} from '../services/promptIntelligenceService';
import { continuationGuideFromVideo, VideoGuideError } from '../services/videoGuideService';
import { SERVER_PRESETS, type PresetDef } from '../config/presets';

export const promptRouter = Router();

const PRESETS_BY_ID: Record<string, PresetDef> = Object.fromEntries(
  SERVER_PRESETS.map((def) => [def.preset_id, def]),
);

// Guard before hitting Postgres — a malformed uuid makes the uuid column comparison throw.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_HINT_LENGTH = 500;

/** Resolves preset_id → its prompt_intelligence block. Returns undefined when preset_id is
 *  absent; sends the 400 itself (and returns null) when preset_id is unknown. */
function resolvePreset(
  presetId: unknown,
  res: Response,
): PresetDef | undefined | null {
  if (presetId === undefined || presetId === null) return undefined;
  if (typeof presetId !== 'string' || !(presetId in PRESETS_BY_ID)) {
    res.status(400).json({ error: 'Unknown preset_id', code: 'INVALID_PRESET' });
    return null;
  }
  return PRESETS_BY_ID[presetId];
}

// ─── POST /api/prompt/enhance ─────────────────────────────────────────────────
promptRouter.post('/enhance', promptModerationMiddleware, async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const prompt = req.body?.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    res.status(400).json({ error: 'prompt is required', code: 'INVALID_PROMPT' });
    return;
  }

  const mode: EnhanceMode = req.body?.mode ?? 'prompt';
  if (mode !== 'prompt' && mode !== 'script') {
    res.status(400).json({ error: "mode must be 'prompt' or 'script'", code: 'INVALID_INPUT' });
    return;
  }

  const preset = resolvePreset(req.body?.preset_id, res);
  if (preset === null) return;

  try {
    const improved = await enhancePrompt({
      prompt: prompt.trim(),
      mode,
      instruction: preset?.prompt_intelligence?.enhance?.instruction,
    });
    res.json({ prompt: improved });
  } catch (err) {
    if (err instanceof PromptIntelligenceError) {
      res.status(502).json({ error: 'Prompt suggestion is temporarily unavailable', code: 'llm_unavailable' });
      return;
    }
    console.error('[prompt/enhance] unexpected error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── POST /api/prompt/from-image ──────────────────────────────────────────────
promptRouter.post('/from-image', async (req: Request, res: Response) => {
  const userId = req.user?.dbUserId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const generationId = req.body?.generation_id;
  const uploadId = req.body?.upload_id;
  const hasGeneration = typeof generationId === 'string' && generationId.length > 0;
  const hasUpload = typeof uploadId === 'string' && uploadId.length > 0;
  if (hasGeneration === hasUpload) {
    res.status(400).json({
      error: 'Provide exactly one of generation_id or upload_id',
      code: 'INVALID_INPUT',
    });
    return;
  }

  const hint = req.body?.hint;
  if (hint !== undefined) {
    if (typeof hint !== 'string' || hint.length > MAX_HINT_LENGTH) {
      res.status(400).json({ error: `hint must be a string of ${MAX_HINT_LENGTH} characters or fewer`, code: 'INVALID_INPUT' });
      return;
    }
  }

  const preset = resolvePreset(req.body?.preset_id, res);
  if (preset === null) return;

  try {
    if (hint) {
      const flagged = await isPromptFlagged(hint);
      if (flagged) {
        res.status(400).json({ error: 'This prompt violates our content policy', code: 'content_policy_violation' });
        return;
      }
    }

    let imageUrl: string;
    if (hasGeneration) {
      if (!UUID_RE.test(generationId)) {
        res.status(404).json({ error: 'Generation not found', code: 'NOT_FOUND' });
        return;
      }
      const rows = await db
        .select()
        .from(generations)
        .where(and(eq(generations.id, generationId), eq(generations.user_id, userId)))
        .limit(1);
      const gen = rows[0];
      if (!gen) {
        res.status(404).json({ error: 'Generation not found', code: 'NOT_FOUND' });
        return;
      }
      if (gen.status !== 'completed' || !gen.r2_key) {
        res.status(409).json({ error: 'Generation is not a completed result', code: 'NOT_READY' });
        return;
      }
      if (gen.media_type !== 'image') {
        res.status(400).json({ error: 'from-image requires an image generation', code: 'NOT_AN_IMAGE' });
        return;
      }
      imageUrl = await getGenerationPresignedUrl(gen.r2_key);
    } else {
      if (!UUID_RE.test(uploadId)) {
        res.status(404).json({ error: 'Upload not found', code: 'NOT_FOUND' });
        return;
      }
      const rows = await db
        .select()
        .from(referenceUploads)
        .where(and(eq(referenceUploads.id, uploadId), eq(referenceUploads.user_id, userId)))
        .limit(1);
      const upload = rows[0];
      if (!upload) {
        res.status(404).json({ error: 'Upload not found', code: 'NOT_FOUND' });
        return;
      }
      if (!upload.mime_type.startsWith('image/')) {
        res.status(400).json({ error: 'from-image requires an image upload', code: 'NOT_AN_IMAGE' });
        return;
      }
      imageUrl = await getUploadPresignedUrl(upload.r2_key);
    }

    const suggested = await promptFromImage({
      imageUrl,
      instruction: preset?.prompt_intelligence?.from_image?.instruction,
      hint: hint || undefined,
    });
    res.json({ prompt: suggested });
  } catch (err) {
    if (err instanceof PromptIntelligenceError) {
      res.status(502).json({ error: 'Prompt suggestion is temporarily unavailable', code: 'llm_unavailable' });
      return;
    }
    console.error('[prompt/from-image] unexpected error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── POST /api/prompt/from-video ──────────────────────────────────────────────
const VIDEO_GUIDE_CACHE_TTL_SECONDS = 1800; // 30min — re-taps/remix-reopens are instant

function videoGuideCacheKey(kind: 'gen' | 'upl', id: string, hint: string | undefined): string {
  const hintHash = hint ? createHash('sha1').update(hint).digest('hex').slice(0, 12) : 'nohint';
  return `videoguide:v1:${kind}:${id}:${hintHash}`;
}

promptRouter.post('/from-video', async (req: Request, res: Response) => {
  const userId = req.user?.dbUserId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const generationId = req.body?.generation_id;
  const uploadId = req.body?.upload_id;
  const hasGeneration = typeof generationId === 'string' && generationId.length > 0;
  const hasUpload = typeof uploadId === 'string' && uploadId.length > 0;
  if (hasGeneration === hasUpload) {
    res.status(400).json({
      error: 'Provide exactly one of generation_id or upload_id',
      code: 'INVALID_INPUT',
    });
    return;
  }

  const hint = req.body?.hint;
  if (hint !== undefined) {
    if (typeof hint !== 'string' || hint.length > MAX_HINT_LENGTH) {
      res.status(400).json({ error: `hint must be a string of ${MAX_HINT_LENGTH} characters or fewer`, code: 'INVALID_INPUT' });
      return;
    }
  }

  try {
    if (hint) {
      const flagged = await isPromptFlagged(hint);
      if (flagged) {
        res.status(400).json({ error: 'This prompt violates our content policy', code: 'content_policy_violation' });
        return;
      }
    }

    let videoUrl: string;
    let cacheKey: string;
    if (hasGeneration) {
      if (!UUID_RE.test(generationId)) {
        res.status(404).json({ error: 'Generation not found', code: 'NOT_FOUND' });
        return;
      }
      const rows = await db
        .select()
        .from(generations)
        .where(and(eq(generations.id, generationId), eq(generations.user_id, userId)))
        .limit(1);
      const gen = rows[0];
      if (!gen) {
        res.status(404).json({ error: 'Generation not found', code: 'NOT_FOUND' });
        return;
      }
      if (gen.status !== 'completed' || !gen.r2_key) {
        res.status(409).json({ error: 'Generation is not a completed result', code: 'NOT_READY' });
        return;
      }
      if (gen.media_type !== 'video') {
        res.status(400).json({ error: 'from-video requires a video generation', code: 'NOT_A_VIDEO' });
        return;
      }
      videoUrl = await getGenerationPresignedUrl(gen.r2_key);
      cacheKey = videoGuideCacheKey('gen', generationId, hint || undefined);
    } else {
      if (!UUID_RE.test(uploadId)) {
        res.status(404).json({ error: 'Upload not found', code: 'NOT_FOUND' });
        return;
      }
      const rows = await db
        .select()
        .from(referenceUploads)
        .where(and(eq(referenceUploads.id, uploadId), eq(referenceUploads.user_id, userId)))
        .limit(1);
      const upload = rows[0];
      if (!upload) {
        res.status(404).json({ error: 'Upload not found', code: 'NOT_FOUND' });
        return;
      }
      if (!upload.mime_type.startsWith('video/')) {
        res.status(400).json({ error: 'from-video requires a video upload', code: 'NOT_A_VIDEO' });
        return;
      }
      videoUrl = await getUploadPresignedUrl(upload.r2_key);
      cacheKey = videoGuideCacheKey('upl', uploadId, hint || undefined);
    }

    // Cache-aside: a re-tap (or a second device) never pays for the same read twice. Cache
    // failures are non-fatal — a guide call is cheap enough to just redo.
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        res.json({ prompt: cached, cached: true });
        return;
      }
    } catch (cacheErr) {
      console.warn('[prompt/from-video] cache read failed, continuing uncached:', cacheErr);
    }

    const guide = await continuationGuideFromVideo({ videoUrl, hint: hint || undefined });

    try {
      await redis.set(cacheKey, guide, 'EX', VIDEO_GUIDE_CACHE_TTL_SECONDS);
    } catch (cacheErr) {
      console.warn('[prompt/from-video] cache write failed:', cacheErr);
    }

    res.json({ prompt: guide });
  } catch (err) {
    if (err instanceof VideoGuideError) {
      res.status(502).json({ error: 'Continuation guide is temporarily unavailable', code: 'llm_unavailable' });
      return;
    }
    console.error('[prompt/from-video] unexpected error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});
