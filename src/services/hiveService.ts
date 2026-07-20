// src/services/hiveService.ts
// Hive Moderation CSAM scan for completed generation videos.
// Called AFTER archiveToR2() in the webhook handler.
// Uses a presigned R2 URL (5 min TTL) — no public bucket required.
// API: Hive v3 Visual Moderation (POST /api/v3/hive/visual-moderation, Bearer auth)
//
// Policy-v2 output classification (real-face paths only; callers own that gate):
//   HIGH — child >= 0.92 AND sexual >= 0.85 on the same frame.
//   LOW  — child >= configured low floor AND sexual >= configured low floor, OR a sexual class
//          independently reaches 0.85 (adult NCII / faceswap abuse backstop).
//
// On Hive errors: caller should queue a retry and never deliver the scoped real-face output.

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { r2, R2_BUCKET } from '../storage/r2';
import { config } from '../config';

const HIVE_TIMEOUT_MS = 30_000;

async function getPresignedUrl(r2Key: string): Promise<string> {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }), { expiresIn: 900 });
}

interface HiveClass {
  class_name: string;
  value: number;
}

interface HiveFrameResult {
  extra: Array<{ name: string; value: unknown }>;
  classes: HiveClass[];
}

interface HiveVisualModerationResponse {
  task_id: string;
  model: string;
  output: HiveFrameResult[];
}

const CHILD_PRESENT_THRESHOLD = 0.92;
const SEXUAL_CONTENT_THRESHOLD = 0.85;
const SEXUAL_CLASS_NAMES = new Set([
  'yes_female_nudity',
  'yes_male_nudity',
  'yes_sexual_activity',
  'yes_sexual_intent',
]);

// INPUT-scan NSFW classes — deliberately EXCLUDES yes_male_nudity. Hive's yes_male_nudity fires on
// a bare male chest (shirtless), which the product allows (user policy 2026-07-11: "shirtless guy
// is fine, naked men is no; bikini is fine, breasts out is no"). Bikinis already pass (not
// yes_female_nudity), and actual naked/sexual imagery is still caught by sexual_activity/intent +
// female_nudity. Kept separate from SEXUAL_CLASS_NAMES so the output CSAM scan is unaffected.
const INPUT_NSFW_CLASS_NAMES = new Set([
  'yes_female_nudity',
  'yes_sexual_activity',
  'yes_sexual_intent',
]);

export type OutputModerationTier = 'none' | 'low' | 'high';

export interface OutputModerationResult {
  flagged: boolean;
  tier: OutputModerationTier;
  reason?: 'csam_hash' | 'csam_classifier' | 'sexual_content';
  childScore: number;
  sexualScore: number;
  hashMatched: boolean;
}

function classifyFrame(classes: HiveClass[]): Omit<OutputModerationResult, 'hashMatched'> {
  const classMap = new Map(classes.map((c) => [c.class_name, c.value]));
  const childScore = classMap.get('yes_child_present') ?? 0;
  const sexualScore = Math.max(...[...SEXUAL_CLASS_NAMES].map((name) => classMap.get(name) ?? 0));

  if (childScore >= CHILD_PRESENT_THRESHOLD && sexualScore >= SEXUAL_CONTENT_THRESHOLD) {
    return { flagged: true, tier: 'high', reason: 'csam_classifier', childScore, sexualScore };
  }
  if (
    (childScore >= config.hiveLowChildThreshold && sexualScore >= config.hiveLowSexualThreshold) ||
    sexualScore >= SEXUAL_CONTENT_THRESHOLD
  ) {
    return { flagged: true, tier: 'low', reason: 'sexual_content', childScore, sexualScore };
  }
  return { flagged: false, tier: 'none', childScore, sexualScore };
}

// Shared v3 visual-moderation request + response parsing, used by BOTH the output CSAM scan
// (scanForCsam) and the input NSFW scan (scanInputMedia). Same endpoint/auth/JSON body — only
// the media URL and the downstream class thresholds differ per caller.
async function visualModerationClasses(mediaUrl: string): Promise<HiveFrameResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIVE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch('https://api.thehive.ai/api/v3/hive/visual-moderation', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.hiveApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: [{ media_url: mediaUrl }] }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`Hive API error: ${response.status}`);
  }

  const data = (await response.json()) as HiveVisualModerationResponse;
  const frames = data.output ?? [];
  // Empty output means Hive couldn't process the media — treat as scan failure, not clean.
  if (frames.length === 0) {
    throw new Error('Hive returned empty output — media could not be scanned');
  }
  return frames;
}

interface HiveThornResponse {
  csam_results?: Array<'thorn_classification' | 'thorn_hash_matching' | string>;
}

// Hive's Combined CSAM API is a separate Moderation Dashboard project. When provisioned, run it
// before general visual moderation so a known hash match or Thorn classifier hit immediately
// enters the high-confidence lane. Any API error fails the whole scoped scan closed.
async function scanWithThorn(mediaUrl: string): Promise<OutputModerationResult | undefined> {
  if (!config.hiveCsamApiKey) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIVE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch('https://api.hivemoderation.com/api/v2/task/sync', {
      method: 'POST',
      headers: {
        Authorization: `token ${config.hiveCsamApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: 'fantasia-system',
        post_id: `moderation-${randomUUID()}`,
        url: mediaUrl,
        thorn_enabled: true,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`Hive Combined CSAM API error: ${response.status}`);

  const results = ((await response.json()) as HiveThornResponse).csam_results ?? [];
  const hashMatched = results.includes('thorn_hash_matching');
  if (hashMatched) {
    return {
      flagged: true,
      tier: 'high',
      reason: 'csam_hash',
      childScore: 0,
      sexualScore: 0,
      hashMatched: true,
    };
  }
  // D-3 reserves automatic reporting for known-hash matches or the tuned two-signal visual
  // combiner. Thorn's classifier-only result is still actionable, but remains in the
  // low-confidence quarantine/refund/strike lane because it has no score exposed here.
  if (results.includes('thorn_classification')) {
    return {
      flagged: true,
      tier: 'low',
      reason: 'csam_classifier',
      childScore: 0,
      sexualScore: 0,
      hashMatched: false,
    };
  }
  return undefined;
}

// Accepts the R2 object key (not a URL) — generates a presigned URL internally.
export async function scanForCsam(r2Key: string): Promise<OutputModerationResult> {
  const presignedUrl = await getPresignedUrl(r2Key);
  const thornResult = await scanWithThorn(presignedUrl);
  if (thornResult) return thornResult;
  const frames = await visualModerationClasses(presignedUrl);
  let strongest: Omit<OutputModerationResult, 'hashMatched'> = {
    flagged: false,
    tier: 'none',
    childScore: 0,
    sexualScore: 0,
  };
  for (const frame of frames) {
    const result = classifyFrame(frame.classes ?? []);
    if (
      result.tier === 'high' ||
      (result.tier === 'low' && strongest.tier === 'none') ||
      (result.tier === strongest.tier && result.childScore + result.sexualScore > strongest.childScore + strongest.sexualScore)
    ) {
      strongest = result;
    }
    if (strongest.tier === 'high') break;
  }
  return { ...strongest, hashMatched: false };
}

// INPUT-media NSFW scan for user-supplied face uploads (faceswap / motion-transfer face slot).
// SEPARATE from scanForCsam: no child_present gating (age is NOT scanned here — D-2), thresholded
// via its own config.hiveInputNsfwThreshold rather than the output SEXUAL_CONTENT_THRESHOLD, and
// gated by its own config.hiveInputScanEnabled flag (checked by callers, not here) rather than
// HIVE_SCAN_REAL_FACE_PATHS. Celebrity likeness is NOT this function's job — see Rekognition
// celebrityCheckMiddleware (D-1).
//
// Fail-safe: on Hive HTTP error or empty/unparseable output, visualModerationClasses() throws —
// this function does not catch it, so callers must treat a thrown error as "block", never as clean.
export async function scanInputMedia(presignedUrl: string): Promise<{ blocked: boolean; reason?: 'nsfw' }> {
  const frames = await visualModerationClasses(presignedUrl);
  const threshold = config.hiveInputNsfwThreshold;
  const isNsfw = frames.some((frame) => {
    const classMap = new Map((frame.classes ?? []).map((c) => [c.class_name, c.value]));
    return [...INPUT_NSFW_CLASS_NAMES].some((name) => (classMap.get(name) ?? 0) >= threshold);
  });
  return isNsfw ? { blocked: true, reason: 'nsfw' } : { blocked: false };
}
