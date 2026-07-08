// src/middleware/inputMediaGate.ts
// Pre-dispatch face-input moderation. Mounted AFTER celebrityCheckMiddleware, BEFORE
// creditCheckMiddleware in POST /api/generations — a block returns 4xx and never deducts credits
// (CLAUDE.md Rule 1/4, mirrors promptModerationMiddleware). Uses scanInputMedia (Hive v2), gated by
// its OWN HIVE_INPUT_SCAN_ENABLED flag (independent of the disabled output scan).
//
// NSFW-only (D-1 + D-2, see 09.2-06 reconciliation banner): celebrity likeness is handled entirely
// by the separate Rekognition celebrityCheckMiddleware; age/minor scanning is dropped.
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { scanInputMedia } from '../services/hiveService';
import { FACE_INPUT_PRESET_IDS, FACE_INPUT_MEDIA_TYPES } from '../config/faceInputPresets';

// Returns the user-supplied face slot URL(s) to scan for a face-input request, or [] if none.
function faceSlotUrls(req: Request): string[] {
  const r = req._resolved;
  if (!r) return [];
  if (r.mediaType === 'avatar' && r.avatarImage) return [r.avatarImage]; // Motion Transfer face photo
  // faceswap slot added in 09.2-07
  return [];
}

function blockMessage(reason?: string): string {
  switch (reason) {
    case 'nsfw':
      return 'This image cannot be used because it may contain explicit content.';
    // celebrity → celebrityCheckMiddleware (Rekognition); age/minor not scanned (D-2)
    default:
      return 'This image cannot be used.';
  }
}

export async function inputMediaGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const presetId = req._preset?.preset_id;
  const mediaType = req._resolved?.mediaType;
  const isFaceInput =
    (!!presetId && FACE_INPUT_PRESET_IDS.has(presetId)) ||
    (!!mediaType && FACE_INPUT_MEDIA_TYPES.has(mediaType));
  if (!isFaceInput || !config.hiveInputScanEnabled) {
    next();
    return;
  }

  const urls = faceSlotUrls(req);
  if (urls.length === 0) {
    next();
    return;
  }

  try {
    for (const url of urls) {
      const { blocked, reason } = await scanInputMedia(url);
      if (blocked) {
        res.status(403).json({ error: blockMessage(reason), code: 'INPUT_MEDIA_BLOCKED', reason });
        return; // no next() → no creditCheck, no dispatch, no deduction
      }
    }
    next();
  } catch (err) {
    console.error('[inputMediaGate] scan error — failing safe (block):', err);
    res.status(403).json({
      error: 'We could not verify this image right now. Please try again.',
      code: 'INPUT_MEDIA_SCAN_ERROR',
    });
  }
}
