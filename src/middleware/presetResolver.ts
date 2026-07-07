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

const PRESETS_BY_ID: Record<string, PresetDef> = Object.fromEntries(
  SERVER_PRESETS.map((def) => [def.preset_id, def]),
);

declare global {
  namespace Express {
    interface Request {
      // input_upload_ids preserves null placeholders for empty optional slots (09.1-11) so a
      // later Remix/reopen can reconstruct which slots were left blank, index-aligned to the
      // preset's input_schema.slots.
      _preset?: { preset_id: string; input_upload_ids: Array<string | null> };
    }
  }
}

// Server-only template expansion — `def.prompt_template` never reaches the client (D-11).
// `{style}` is substituted with the VALIDATED style_grid label (never raw client text).
function expandTemplate(def: PresetDef, styleLabel: string | undefined): string {
  const template = def.prompt_template ?? '';
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

  try {
    // Style grid validation (e.g. hairstyle) — 400 if the sent style id isn't in the def.
    let styleLabel: string | undefined;
    if (def.input_schema?.style_grid?.length) {
      const styleId = req.body.style_id;
      const match = def.input_schema.style_grid.find((s) => s.id === styleId);
      if (!match) {
        res.status(400).json({ error: 'Unknown or missing style', code: 'INVALID_STYLE' });
        return;
      }
      styleLabel = match.label;
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
    req.body.prompt = expandTemplate(def, styleLabel);

    const maxSeconds = def.cost?.type === 'per_second' ? def.cost.max_seconds : undefined;

    switch (def.media_type) {
      case 'avatar': {
        // Motion Transfer: image + driving video slots.
        req.body.avatar_image = slotUrls[0];
        req.body.avatar_driving_video = slotUrls[1];
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
        req.body.character_replace_video = slotUrls[0];
        req.body.character_replace_image = slotUrls[1];
        const clientDuration =
          typeof req.body.estimated_duration_seconds === 'number' && req.body.estimated_duration_seconds > 0
            ? req.body.estimated_duration_seconds
            : 5;
        req.body.estimated_duration_seconds = maxSeconds ? Math.min(clientDuration, maxSeconds) : clientDuration;
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
        // Clothes Swap/Hairstyle/Anime Yourself/Polaroid — 1-4 reference image slots, no user
        // duration. 09.1-11: slots may declare `optional: true` (Clothes Swap's 2 extra outfit
        // references) — every NON-optional slot must resolve to a real presigned URL, or reject
        // before any billing/dispatch happens. This is a no-op for every preset whose slots
        // declare no `optional` flag (hairstyle/anime-yourself/polaroid) since all of theirs are
        // implicitly required, matching their pre-existing behavior exactly.
        const slots = def.input_schema?.slots ?? [];
        const missingRequired = slots.some((slot, index) => !slot.optional && !slotUrls[index]);
        if (missingRequired) {
          res.status(400).json({ error: 'Missing required image', code: 'INVALID_PRESET_INPUT' });
          return;
        }
        req.body.reference_images = slotUrls.filter(Boolean);
        break;
      }
      case 'video': {
        // Animate Old Photo — image-to-video, fixed short duration (no user-selectable duration
        // slot in the schema); use the preset's declared max_seconds as the actual duration.
        req.body.reference_images = slotUrls;
        req.body.duration = maxSeconds ?? 5;
        req.body.resolution = '720p';
        break;
      }
      default:
        break;
    }

    req._preset = { preset_id, input_upload_ids: uploadIds };
    next();
  } catch (err) {
    console.error('[presetResolver] Error resolving preset:', err);
    res.status(500).json({ error: 'Failed to resolve preset' });
  }
}
