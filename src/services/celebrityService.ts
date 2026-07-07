// src/services/celebrityService.ts
// Celebrity-likeness detection via AWS Rekognition RecognizeCelebrities.
// Used to block the upload-driven motion-transfer / ai-influencer presets from animating a real
// public figure's face (right-of-publicity / deepfake protection — see
// ~/.planning/celebrity-likeness-check-plan.md and the Phase 5 moderation carve-out).
//
// Placement note: this runs PRE-dispatch on the user's uploaded FACE image (cheaper than scoring a
// generated frame, and it stops the deepfake before it's ever produced). Mirrors hiveService.ts's
// single-purpose shape and promptModeration.ts's fail-open-on-error convention.
//
// Rekognition's Image.Bytes path caps at 5 MB, and R2 is not S3 so we can't use the larger
// Image.S3Object path. Modern phone photos routinely exceed 5 MB, so we DOWNSCALE the copy sent to
// Rekognition (via sharp) to stay under the limit — face recognition doesn't need full resolution,
// and the original upload the user submitted for generation is never modified. Only genuinely
// enormous downloads (> MAX_DOWNLOAD_BYTES) or a post-downscale overflow fail open.

import { RekognitionClient, RecognizeCelebritiesCommand } from '@aws-sdk/client-rekognition';
import sharp from 'sharp';
import { config } from '../config';

export interface CelebrityCheckResult {
  matched: boolean;
  name?: string;
  /** MatchConfidence 0–100 of the highest-confidence celebrity face, when matched. */
  confidence?: number;
}

const NOT_MATCHED: CelebrityCheckResult = { matched: false };

const REKOGNITION_BYTES_LIMIT = 5 * 1024 * 1024; // hard AWS cap for the inline-bytes path
const SEND_LIMIT = Math.floor(4.5 * 1024 * 1024); // downscale above this, leaving headroom under the cap
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // don't even download absurdly large files (waste/DoS guard)
const MAX_EDGE_PX = 2048; // long-edge cap for the downscaled copy — ample for face recognition

/** Return bytes that fit Rekognition's inline limit. Small images pass through untouched; larger
 *  ones are resized (long edge → MAX_EDGE_PX) and re-encoded JPEG. Respects EXIF orientation so a
 *  portrait face isn't sent sideways. Exported for the downscale smoke test. */
export async function fitForRekognition(raw: Uint8Array): Promise<Uint8Array> {
  if (raw.byteLength <= SEND_LIMIT) return raw;
  const resized = await sharp(Buffer.from(raw))
    .rotate() // apply EXIF orientation
    .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return new Uint8Array(resized);
}

let client: RekognitionClient | null = null;

function getClient(): RekognitionClient {
  if (!client) {
    client = new RekognitionClient({
      region: config.awsRegion,
      // Fall back to the default AWS credential chain (env/instance role) when explicit keys
      // aren't set, so this also works on infra that injects a role.
      credentials:
        config.awsAccessKeyId && config.awsSecretAccessKey
          ? { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey }
          : undefined,
    });
  }
  return client;
}

/**
 * Returns whether the face image at `imageUrl` matches a known celebrity above the configured
 * threshold. FAILS OPEN (returns { matched: false }) on any error — a transient Rekognition/network
 * problem must not take down the generation feature. Callers gate on `config.celebrityCheckEnabled`.
 */
export async function checkCelebrity(imageUrl: string): Promise<CelebrityCheckResult> {
  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) {
      console.error(`[celebrityService] Could not fetch image (${resp.status}); failing open`);
      return NOT_MATCHED;
    }

    const contentLength = Number(resp.headers.get('content-length') ?? '0');
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      console.warn(`[celebrityService] Image ${contentLength}B exceeds ${MAX_DOWNLOAD_BYTES}B download cap; failing open`);
      return NOT_MATCHED;
    }

    const raw = new Uint8Array(await resp.arrayBuffer());
    const bytes = await fitForRekognition(raw);
    if (bytes.byteLength > REKOGNITION_BYTES_LIMIT) {
      // Should be unreachable after a 2048px JPEG downscale, but never send an over-limit payload.
      console.warn(`[celebrityService] Image still ${bytes.byteLength}B after downscale; failing open`);
      return NOT_MATCHED;
    }

    const result = await getClient().send(
      new RecognizeCelebritiesCommand({ Image: { Bytes: bytes } }),
    );

    const top = (result.CelebrityFaces ?? [])
      .filter((c) => typeof c.MatchConfidence === 'number')
      .sort((a, b) => (b.MatchConfidence ?? 0) - (a.MatchConfidence ?? 0))[0];

    if (top && (top.MatchConfidence ?? 0) >= config.celebrityMatchThreshold) {
      console.log(`[celebrityService] Celebrity match: ${top.Name} (${top.MatchConfidence}%)`);
      return { matched: true, name: top.Name, confidence: top.MatchConfidence };
    }

    return NOT_MATCHED;
  } catch (err) {
    // Fail open (see promptModeration.ts precedent) — do not block a legit user on our error.
    console.error('[celebrityService] RecognizeCelebrities failed; failing open:', err);
    return NOT_MATCHED;
  }
}
