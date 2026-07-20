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
import { FACE_INPUT_PRESET_IDS, isRealFaceGenerationPath } from '../config/faceInputPresets';

// Returns the user-supplied face slot URL(s) to scan for a face-input request, or [] if none.
function faceSlotUrls(req: Request): string[] {
  const r = req._resolved;
  if (!r) return [];
  if (r.mediaType === 'avatar' && r.avatarImage) return [r.avatarImage]; // Motion Transfer face photo
  // Faceswap: scan the user's OWN uploaded face (swap source), never the target photo (09.2-07).
  if (r.mediaType === 'faceswap' && r.swapImage) return [r.swapImage];
  // 09.6 GAP-2: Korean Baseball Fan Cam is single-shot HappyHorse (media_type 'video', selfie in
  // referenceImages[0]). Guarded by registered preset_id membership so freeform 'video' presets
  // (camera-moves, animate-old-photo) are NEVER blanket-scanned — only a registered face-input
  // preset's selfie is scanned here.
  const presetId = req._preset?.preset_id;
  if (r.mediaType === 'video' && presetId && FACE_INPUT_PRESET_IDS.has(presetId) && r.referenceImages?.length) {
    return r.referenceImages;
  }
  // 09.6 GAP-2: forward-protection for the wired Wan/DreamActor Marlon Motion Transfer fallbacks
  // (D-03) — scans the user's uploaded face photo before dispatch.
  if (r.mediaType === 'character_replace' && r.characterReplaceImage) return [r.characterReplaceImage];
  // 09.6 GAP-2/Plan 04: the 'chain' media_type case — You vs You's resolved photo slot(s) feed
  // the chain's image_stage; scan every one before dispatch (T-09.6-10).
  if (r.mediaType === 'chain' && r.chainInputImages?.length) return r.chainInputImages;
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
  const isFaceInput = !!mediaType && isRealFaceGenerationPath(presetId, mediaType);
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
