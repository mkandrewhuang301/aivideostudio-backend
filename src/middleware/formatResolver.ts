// src/middleware/formatResolver.ts
//
// Mounted after presetResolver and before prepareCost in POST /api/generations. When the client
// sends a string format_id, this resolves the live server registry row, validates every format
// input, and overwrites the request with server-owned descriptors. Cost comes entirely from the
// server format descriptor; the client's cost, media type, model, and duration are never read for
// billing (T-14-COST, mirrors T-09.6-09).

import { Request, Response, NextFunction } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { FORMATS_BY_ID } from '../config/formats';
import { db } from '../db/client';
import { referenceUploads } from '../db/schema';

const MAX_ATTACHMENTS = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidAttachment(res: Response): void {
  res.status(400).json({ error: 'Invalid attachment', code: 'INVALID_ATTACHMENT' });
}

declare global {
  namespace Express {
    interface Request {
      /** Unforgeable-by-JSON marker proving formatResolver produced the __format_* body fields. */
      _formatResolved?: true;
    }
  }
}

export async function formatResolver(req: Request, res: Response, next: NextFunction): Promise<void> {
  const body = req.body ?? {};
  if (typeof body.format_id !== 'string') {
    next();
    return;
  }

  const def = FORMATS_BY_ID[body.format_id];
  if (!def || def.status !== 'live') {
    res.status(400).json({ error: 'Unknown format', code: 'INVALID_FORMAT' });
    return;
  }

  const styleId = typeof body.style_id === 'string' ? body.style_id : '';
  const style = def.style_grid.find((candidate) => candidate.id === styleId);
  if (!style) {
    res.status(400).json({ error: 'Invalid style', code: 'INVALID_STYLE' });
    return;
  }

  // Explainer tier. When the client omits it, default to a method the chosen style supports —
  // preferring 'illustrated' (the cheaper default per the locked contract) when available, else the
  // style's own method (some styles are animated-only, e.g. pixel-art). An explicit value must be a
  // valid method the style supports (style_grid rows are tagged with the methods they belong to).
  let visualMethod: 'illustrated' | 'animated';
  if (body.visual_method === undefined) {
    visualMethod = style.methods.includes('illustrated') ? 'illustrated' : style.methods[0]!;
  } else if (
    (body.visual_method === 'illustrated' || body.visual_method === 'animated')
    && style.methods.includes(body.visual_method)
  ) {
    visualMethod = body.visual_method;
  } else {
    res.status(400).json({ error: 'Invalid visual method', code: 'INVALID_VISUAL_METHOD' });
    return;
  }

  const matchedTier = def.duration_tiers.find((tier) => tier.seconds === body.duration_seconds);
  if (!matchedTier) {
    res.status(400).json({ error: 'Invalid duration', code: 'INVALID_DURATION' });
    return;
  }

  const topic = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!topic) {
    res.status(400).json({ error: 'Invalid input', code: 'INVALID_INPUT' });
    return;
  }

  const voiceId = body.voice_id === undefined ? def.voice_default : body.voice_id;
  if (typeof voiceId !== 'string' || !def.voices.some((voice) => voice.id === voiceId)) {
    res.status(400).json({ error: 'Invalid voice', code: 'INVALID_VOICE' });
    return;
  }

  const music = body.music === undefined ? 'auto' : body.music;
  if (typeof music !== 'string' || !def.music_moods.includes(music)) {
    res.status(400).json({ error: 'Invalid music', code: 'INVALID_MUSIC' });
    return;
  }

  const aspectRatio = body.aspect_ratio === undefined ? def.aspect_ratios[0] : body.aspect_ratio;
  if (typeof aspectRatio !== 'string' || !def.aspect_ratios.some((ratio) => ratio === aspectRatio)) {
    res.status(400).json({ error: 'Invalid aspect ratio', code: 'INVALID_ASPECT_RATIO' });
    return;
  }

  let sourceUrl: string | null = null;
  if (body.source_url !== undefined && body.source_url !== null) {
    if (typeof body.source_url !== 'string') {
      res.status(400).json({ error: 'Invalid input', code: 'INVALID_INPUT' });
      return;
    }
    try {
      const parsed = new URL(body.source_url.trim());
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error('unsupported source URL');
      }
      sourceUrl = parsed.toString();
    } catch {
      res.status(400).json({ error: 'Invalid input', code: 'INVALID_INPUT' });
      return;
    }
  }

  const rawAttachmentIds = body.attachment_ids;
  if (rawAttachmentIds !== undefined && !Array.isArray(rawAttachmentIds)) {
    invalidAttachment(res);
    return;
  }
  const attachmentIds = (rawAttachmentIds ?? []) as unknown[];
  if (
    attachmentIds.length > MAX_ATTACHMENTS
    || attachmentIds.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))
  ) {
    invalidAttachment(res);
    return;
  }

  try {
    const resolvedAttachments: Array<{ r2Key: string; mimeType: string }> = [];
    if (attachmentIds.length > 0) {
      const userId = req.user?.dbUserId;
      if (!userId) {
        invalidAttachment(res);
        return;
      }
      const ids = attachmentIds as string[];
      const rows = await db
        .select({
          id: referenceUploads.id,
          r2Key: referenceUploads.r2_key,
          mimeType: referenceUploads.mime_type,
        })
        .from(referenceUploads)
        .where(and(inArray(referenceUploads.id, ids), eq(referenceUploads.user_id, userId)));
      const rowsById = new Map(rows.map((row) => [row.id, row]));

      for (const id of ids) {
        const row = rowsById.get(id);
        if (!row || (!row.mimeType.startsWith('image/') && row.mimeType !== 'application/pdf')) {
          invalidAttachment(res);
          return;
        }
        resolvedAttachments.push({ r2Key: row.r2Key, mimeType: row.mimeType });
      }
    }

    req.body.media_type = 'format';
    req.body.__format_def = def;
    req.body.__format_tier = matchedTier;
    req.body.__format_inputs = {
      style_id: styleId,
      visual_method: visualMethod,
      topic,
      voice_id: voiceId,
      music,
      aspectRatio,
      attachments: resolvedAttachments,
      sourceUrl,
    };
    req._formatResolved = true;
    next();
  } catch (err) {
    console.error('[formatResolver] Error resolving format:', err);
    res.status(500).json({ error: 'Failed to resolve format' });
  }
}
