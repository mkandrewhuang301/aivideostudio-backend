// src/routes/prompt.ts
// LLM prompt-intelligence endpoints (mounted at /api/prompt behind auth + banCheck):
//   POST /enhance    — { prompt, mode?: 'prompt'|'script', preset_id? }        → { prompt }
//   POST /from-image — { generation_id? | upload_id?, preset_id?, hint? }      → { prompt }
//
// Both are FREE (no credit deduction — gpt-4o-mini costs fractions of a cent) and fail loud
// (502 llm_unavailable) rather than echoing input back. Per-preset behavior comes from
// PresetDef.prompt_intelligence (SERVER-ONLY registry config) keyed by the optional preset_id.
//
// SECURITY:
// - from-image NEVER accepts a client-supplied URL — only a generation_id/upload_id, resolved
//   to a presigned R2 URL server-side with an ownership (IDOR) guard. Accepting raw URLs would
//   be an SSRF hole.
// - /enhance input runs through the same two-layer prompt moderation as POST /api/generations;
//   from-image's `hint` runs through isPromptFlagged directly.
// - Quarantined/incomplete generations are never presigned (mirrors the delivery gate posture).

import { Router, Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { generations, referenceUploads } from '../db/schema';
import { getGenerationPresignedUrl, getUploadPresignedUrl } from '../services/archivalService';
import { isPromptFlagged, promptModerationMiddleware } from '../middleware/promptModeration';
import {
  enhancePrompt,
  promptFromImage,
  PromptIntelligenceError,
  type EnhanceMode,
} from '../services/promptIntelligenceService';
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
