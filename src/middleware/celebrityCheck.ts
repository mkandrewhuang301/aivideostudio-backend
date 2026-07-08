// src/middleware/celebrityCheck.ts
// Blocks the upload-driven motion-transfer / ai-influencer presets from animating a real
// celebrity's face (right-of-publicity / deepfake protection — see
// ~/.planning/celebrity-likeness-check-plan.md).
//
// Placement (generations.ts chain): AFTER prepareCost (so req._resolved.mediaType + the resolved
// face-image URL exist) and BEFORE creditCheckMiddleware (so a block deducts NO credits — "hard
// block, no charge", the user-confirmed enforcement). Mirrors promptModeration.ts's 400+code reject.
//
// Scoped to media_type ∈ {avatar, character_replace, faceswap} only; every other preset
// short-circuits with next() and pays zero latency/cost. Gated by config.celebrityCheckEnabled
// (default OFF).

import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { checkCelebrity } from '../services/celebrityService';

export async function celebrityCheckMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!config.celebrityCheckEnabled) {
    next();
    return;
  }

  const resolved = req._resolved;
  // Only the two upload-driven face presets carry a face image to check. For everything else
  // (text video/image, upscale) there's no uploaded identity — skip.
  const faceImageUrl =
    resolved?.mediaType === 'avatar'
      ? resolved.avatarImage // Motion Transfer: "Your photo"
      : resolved?.mediaType === 'character_replace'
        ? resolved.characterReplaceImage // AI Influencer: "Choose your character"
        : resolved?.mediaType === 'faceswap'
          ? resolved.swapImage // Faceswap: "Your face" (swap source)
          : undefined;

  if (!faceImageUrl) {
    next();
    return;
  }

  const result = await checkCelebrity(faceImageUrl);
  if (result.matched) {
    console.log(`[celebrityCheck] Blocked ${resolved?.mediaType} upload — matched ${result.name} (${result.confidence}%)`);
    res.status(400).json({
      error:
        "This image looks like a real public figure. To protect against unauthorized likenesses, " +
        "we can't animate it. You weren't charged.",
      code: 'celebrity_likeness_blocked',
    });
    return;
  }

  next();
}
