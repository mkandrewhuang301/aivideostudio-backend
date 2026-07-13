// src/middleware/presetResolver.ts
//
// Mounted BEFORE prepareCost in the POST /api/generations chain (after promptModeration).
// When the client sends `preset_id`, this looks up the server-side registry def, expands the
// prompt template, and OVERWRITES req.body.media_type/model/prompt from the def — the client's
// values for those fields are never read (T-09.1-02: tampering-proof). It then rewrites the
// request into the shape prepareCost's existing avatar/upscale/image/video branches already
// validate + bill (RESEARCH.md Pattern 2).
//
// Client contract: `preset_id` (string), `preset_input_upload_ids` (string[] of reference_uploads
// ids, index-aligned to the preset's `input_schema.slots`), optional `style_id` (must match one
// of the preset's `input_schema.style_grid` entries), optional `estimated_duration_seconds` for
// avatar/video-upscale/character-replace presets (used only as a starting point — clamped
// server-side, D-16).
//
// D-16 / Pitfall 4 / T-09.1-07: for any preset whose cost declares `max_seconds`, the resolved
// duration is clamped to that cap BEFORE prepareCost computes cost — this must happen here, not
// after, per CLAUDE.md Rule 7 (never bill on an untrusted/unclamped duration).

import { Request, Response, NextFunction } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { referenceUploads } from '../db/schema';
import { getUploadPresignedUrl } from '../services/archivalService';
import { SERVER_PRESETS, type PresetDef } from '../config/presets';
import { PERMISSIVE_I2V_MODEL } from '../services/generationService';
import { expandScript } from '../services/openaiScriptService';

const PRESETS_BY_ID: Record<string, PresetDef> = Object.fromEntries(
  SERVER_PRESETS.map((def) => [def.preset_id, def]),
);

declare global {
  namespace Express {
    interface Request {
      // input_upload_ids preserves null placeholders for empty optional slots (09.1-11) so a
      // later Remix/reopen can reconstruct which slots were left blank, index-aligned to the
      // preset's input_schema.slots. `postprocess` (09.3-05) is only present when the resolved
      // preset declares one — generations.ts merges it onto the created row's params.postprocess.
      _preset?: {
        preset_id: string;
        input_upload_ids: Array<string | null>;
        postprocess?: { op: 'mux' | 'concat'; audio_r2_key?: string };
      };
    }
  }
}

// Server-only template expansion — `def.prompt_template`/`prompt_template_with_reference` never
// reach the client (D-11). `{style}` is substituted with the VALIDATED style_grid label (never
// raw client text). `hasStyleReferenceImage` picks the two-image-aware template when the
// resolved style option carries a `thumb_url` (sent as a second reference image below).
function expandTemplate(def: PresetDef, styleLabel: string | undefined, hasStyleReferenceImage: boolean): string {
  const template = (hasStyleReferenceImage && def.prompt_template_with_reference) || def.prompt_template || '';
  if (!template) return template;
  return styleLabel ? template.replace('{style}', styleLabel) : template;
}

export async function presetResolver(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { preset_id } = req.body ?? {};
  if (!preset_id || typeof preset_id !== 'string') {
    next(); // freeform path unchanged
    return;
  }

  const def = PRESETS_BY_ID[preset_id];
  if (!def || def.status !== 'live') {
    res.status(400).json({ error: 'Unknown preset', code: 'INVALID_PRESET' });
    return;
  }

  // Captured BEFORE the OVERWRITE below clobbers req.body.prompt with the server template —
  // magic-editor's branch (its 'image' case) needs the client's original free-text value, and
  // reading req.body.prompt at that point would see expandTemplate()'s output instead (for
  // magic-editor, the literal passthrough marker string '{prompt}', not real user text).
  const rawClientPrompt = typeof req.body.prompt === 'string' ? req.body.prompt : '';

  try {
    // Style grid validation (e.g. hairstyle) — 400 if the sent style id isn't in the def.
    let styleLabel: string | undefined;
    // When the matched style option carries a thumb_url, it doubles as the reference image sent
    // to the model alongside the user's own photo (appended in the 'image' case below).
    let styleReferenceUrl: string | undefined;
    // 09.3 D-04: viral motion packs bundle the DreamActor driving video PER STYLE OPTION rather
    // than as a second user-uploaded slot — see the 'avatar' case below.
    let styleDrivingVideoUrl: string | undefined;
    if (def.input_schema?.style_grid?.length) {
      const styleId = req.body.style_id;
      const match = def.input_schema.style_grid.find((s) => s.id === styleId);
      if (!match) {
        res.status(400).json({ error: 'Unknown or missing style', code: 'INVALID_STYLE' });
        return;
      }
      styleLabel = match.label;
      styleReferenceUrl = match.thumb_url;
      styleDrivingVideoUrl = match.driving_video_url;
    }

    // Resolve slot inputs: client sends reference_uploads ids (index-aligned to input_schema.slots),
    // never raw URLs — look each up ownership-scoped and presign a fresh URL (Issue 4 pattern:
    // never trust a client-sent presigned URL, which may already be stale).
    //
    // 09.1-11: preserve array LENGTH and index alignment — a non-string entry (null, the
    // client's placeholder for a skipped optional slot) becomes `null` here rather than being
    // filtered out, so slotUrls stays index-aligned to input_schema.slots below. Do NOT compact
    // this array; a shorter array would silently misalign every slot after the first gap.
    const uploadIds: Array<string | null> = Array.isArray(req.body.preset_input_upload_ids)
      ? (req.body.preset_input_upload_ids as unknown[]).map((id) => (typeof id === 'string' ? id : null))
      : [];

    const userId = req.user?.dbUserId;
    const nonNullIds = uploadIds.filter((id): id is string => id !== null);
    let slotUrls: string[] = [];
    if (nonNullIds.length > 0 && userId) {
      const rows = await db
        .select()
        .from(referenceUploads)
        .where(and(inArray(referenceUploads.id, nonNullIds), eq(referenceUploads.user_id, userId)));
      const rowById = Object.fromEntries((rows as Array<{ id: string; r2_key: string }>).map((r) => [r.id, r]));
      slotUrls = await Promise.all(
        uploadIds.map(async (id) => {
          if (id === null) return '';
          const row = rowById[id];
          return row ? await getUploadPresignedUrl(row.r2_key) : '';
        }),
      );
    }

    // OVERWRITE — never merge/trust client-sent model/prompt/media_type (T-09.1-02).
    req.body.media_type = def.media_type;
    req.body.model = def.model;
    req.body.prompt = expandTemplate(def, styleLabel, !!styleReferenceUrl);

    // 09.3 D-02 provenance pre-route: known real-face presets skip the doomed Seedance attempt
    // and dispatch straight to the config-driven permissive model; known-fictional presets keep
    // Seedance (def.model, already set above); 'try_seedance_fallback_grok' also keeps Seedance —
    // the webhook's content_policy fallback branch (09.3-03) handles the Grok redispatch on block.
    if (def.i2v_routing === 'grok') {
      req.body.model = PERMISSIVE_I2V_MODEL;
    }

    // 09.3 D-05: script-driven presets (e.g. gorilla vlogger) expand the user's raw script into a
    // dialogue-ready prompt via the LLM helper — fail-open (never throws) to the templated
    // dialogue/prompt with {script} substituted, so a transient LLM outage never blocks dispatch.
    if (def.script_expansion) {
      const userScript = typeof req.body.text === 'string' ? req.body.text : '';
      if (def.input_schema?.text?.required && !userScript.trim()) {
        res.status(400).json({ error: 'text is required', code: 'INVALID_PRESET_INPUT' });
        return;
      }
      const dialogueTemplate = def.dialogue_prompt_template || def.prompt_template || '{script}';
      req.body.prompt = await expandScript({ userScript, dialogueTemplate });
      // Dialogue needs synthesized speech — Seedance's audio-on ref-to-video path (D-05).
      req.body.audio_enabled = true;
    }

    const maxSeconds = def.cost?.type === 'per_second' ? def.cost.max_seconds : undefined;

    switch (def.media_type) {
      case 'avatar': {
        // Motion Transfer: image + driving video slots. Viral motion packs (09.3 D-04) instead
        // bundle the driving video PER STYLE OPTION (styleDrivingVideoUrl) — only the selfie slot
        // is a user upload in that case, so the bundled URL takes priority over a second slot.
        req.body.avatar_image = slotUrls[0];
        req.body.avatar_driving_video = styleDrivingVideoUrl || slotUrls[1];
        const clientDuration =
          typeof req.body.estimated_duration_seconds === 'number' && req.body.estimated_duration_seconds > 0
            ? req.body.estimated_duration_seconds
            : 5;
        // D-16/Pitfall 4/T-09.1-07: clamp BEFORE prepareCost computes cost via computeDreamActorCost.
        req.body.estimated_duration_seconds = maxSeconds ? Math.min(clientDuration, maxSeconds) : clientDuration;
        break;
      }
      case 'character_replace': {
        // AI Influencer (D-23): user's own video (motion/background source) + a character image
        // that replaces them — the inverse framing from Motion Transfer, which keeps the PHOTO's
        // background rather than the user's own video's background.
        // Marlon Motion Transfer (09.6 D-03): a BUNDLED driver clip (def.driver_video_asset)
        // replaces the user-uploaded video slot — the user's single photo slot (slotUrls[0])
        // becomes character_replace_image, pairing with the bundled driver as
        // character_replace_video. ai-influencer (no driver_video_asset) keeps the original
        // two-slot shape unchanged.
        if (def.driver_video_asset) {
          req.body.character_replace_video = def.driver_video_asset;
          req.body.character_replace_image = slotUrls[0];
        } else {
          req.body.character_replace_video = slotUrls[0];
          req.body.character_replace_image = slotUrls[1];
        }
        const clientDuration =
          typeof req.body.estimated_duration_seconds === 'number' && req.body.estimated_duration_seconds > 0
            ? req.body.estimated_duration_seconds
            : 5;
        req.body.estimated_duration_seconds = maxSeconds ? Math.min(clientDuration, maxSeconds) : clientDuration;
        // AI Influencer Pro tier: 3-step pipeline (frame extract -> Wan 2.7 composite -> Kling v3
        // Motion Control) instead of the direct Wan 2.2 Animate Replace dispatch. Scoped strictly
        // to preset_id === 'ai-influencer' — Marlon Motion Transfer (09.6 D-03) is deliberately
        // single-shot-only and must never take this path even if a stray `quality` field were
        // sent against it.
        if (preset_id === 'ai-influencer' && req.body.quality === 'pro') {
          req.body.character_replace_quality = 'pro';
        }
        break;
      }
      case 'upscale': {
        if (def.model === 'recraft-ai/recraft-crisp-upscale') {
          // Enhancer (image path) — flat cost, single image field.
          req.body.upscale_image_url = slotUrls[0];
        } else {
          // Enhancer (video path) — existing ByteDance Video Upscaler branch.
          req.body.source_video_url = slotUrls[0];
          const clientDuration =
            typeof req.body.estimated_duration_seconds === 'number' && req.body.estimated_duration_seconds > 0
              ? req.body.estimated_duration_seconds
              : 5;
          req.body.estimated_duration_seconds = maxSeconds ? Math.min(clientDuration, maxSeconds) : clientDuration;
        }
        break;
      }
      case 'image': {
        // Clothes Swap/Hairstyle/Anime Yourself/Polaroid/Magic Editor — 1-4 reference image
        // slots, no user duration. 09.1-11: slots may declare `optional: true` (Clothes Swap's 2
        // extra outfit references) — every NON-optional slot must resolve to a real presigned
        // URL, or reject before any billing/dispatch happens. This is a no-op for every preset
        // whose slots declare no `optional` flag (hairstyle/anime-yourself/polaroid/magic-editor)
        // since all of theirs are implicitly required, matching their pre-existing behavior exactly.
        const slots = def.input_schema?.slots ?? [];
        const missingRequired = slots.some((slot, index) => !slot.optional && !slotUrls[index]);
        if (missingRequired) {
          res.status(400).json({ error: 'Missing required image', code: 'INVALID_PRESET_INPUT' });
          return;
        }
        // styleReferenceUrl (hairstyle's per-style thumb_url, once populated) is appended AFTER
        // the user's own slot photo(s) — order matches prompt_template_with_reference's
        // "first image" / "second image" framing.
        req.body.reference_images = [...slotUrls.filter(Boolean), ...(styleReferenceUrl ? [styleReferenceUrl] : [])];

        // Magic Editor (09.2-08, T-09.2-17): resolve the client's mask_upload_id to a fresh
        // presigned URL, ownership-scoped to req.user.dbUserId via the SAME referenceUploads
        // lookup pattern used above for slot inputs — never trust a client-sent presigned URL
        // (Issue 4 pattern) and never let another user's upload resolve as the mask.
        // Also pass the user's free-text straight through as the prompt (the only image preset
        // with a user-authored prompt; every other image preset's prompt is fully server-
        // templated per D-11, so this is gated to preset_id === 'magic-editor' only).
        if (preset_id === 'magic-editor') {
          const maskUploadId = typeof req.body.mask_upload_id === 'string' ? req.body.mask_upload_id : undefined;
          if (!maskUploadId || !userId) {
            res.status(400).json({ error: 'mask_upload_id is required', code: 'INVALID_PRESET_INPUT' });
            return;
          }
          const [maskRow] = await db
            .select()
            .from(referenceUploads)
            .where(and(eq(referenceUploads.id, maskUploadId), eq(referenceUploads.user_id, userId)));
          if (!maskRow) {
            res.status(400).json({ error: 'Mask upload not found', code: 'INVALID_PRESET_INPUT' });
            return;
          }
          req.body.mask_url = await getUploadPresignedUrl((maskRow as { r2_key: string }).r2_key);

          // The painted alpha mask is an internal artifact, not a user-facing reference. Now that
          // we know this upload IS a mask, tag its kind so GET /api/uploads excludes it from the
          // @-mention library (it stays unnamed, so the 24h upload reaper still cleans it up).
          // (2026-07-13 — masks were leaking into the reference list.)
          await db
            .update(referenceUploads)
            .set({ kind: 'mask' })
            .where(and(eq(referenceUploads.id, maskUploadId), eq(referenceUploads.user_id, userId)));

          req.body.prompt = rawClientPrompt.trim();
        }
        break;
      }
      case 'faceswap': {
        // Easel Advanced Face Swap: slot 0 = user's face (swap), slot 1 = target photo. No duration.
        req.body.swap_image = slotUrls[0];
        req.body.target_image = slotUrls[1];
        break;
      }
      case 'chain': {
        // Chained-job primitive (09.6, D-01/D-05) — sole consumer is You vs You (UVU). The
        // resolved user photo slot(s) feed the chain's image_stage; the animate/mux config lives
        // entirely in def.chain (server-only, never reaches the client). Do NOT overwrite
        // req.body.prompt here — chain presets carry no prompt_template, so the outer OVERWRITE
        // above already left it '' (expandTemplate returns '' with no template to expand).
        if (!def.chain) {
          res.status(400).json({ error: 'Preset is missing its chain descriptor', code: 'INVALID_PRESET' });
          return;
        }
        const resolvedSlots = slotUrls.filter(Boolean);
        if (resolvedSlots.length === 0) {
          res.status(400).json({ error: 'Missing required photo', code: 'INVALID_PRESET_INPUT' });
          return;
        }
        req.body.chain_input_images = resolvedSlots;
        req.body.__chain_def = def.chain;
        break;
      }
      case 'video': {
        // Animate Old Photo — image-to-video, fixed short duration (no user-selectable duration
        // slot in the schema); use the preset's declared max_seconds as the actual duration.
        // Character vlogger (09.3 D-05): character_asset (bundled canonical character still) goes
        // FIRST in reference_images, ahead of any user upload slots.
        req.body.reference_images = def.character_asset
          ? [def.character_asset, ...slotUrls.filter(Boolean)]
          : slotUrls;
        req.body.duration = maxSeconds ?? 5;
        req.body.resolution = '720p';
        break;
      }
      default:
        break;
    }

    req._preset = {
      preset_id,
      input_upload_ids: uploadIds,
      ...(def.postprocess ? { postprocess: def.postprocess } : {}),
    };
    next();
  } catch (err) {
    console.error('[presetResolver] Error resolving preset:', err);
    res.status(500).json({ error: 'Failed to resolve preset' });
  }
}
