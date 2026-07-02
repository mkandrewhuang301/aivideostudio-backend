// src/services/hiveService.ts
// Hive Moderation CSAM scan for completed generation videos.
// Called AFTER archiveToR2() in the webhook handler.
// Uses a presigned R2 URL (5 min TTL) — no public bucket required.
// API: Hive v3 Visual Moderation (POST /api/v3/hive/visual-moderation, Bearer auth)
//
// CSAM flag logic: flag the video if ANY frame has BOTH:
//   - yes_child_present >= 0.92
//   - ANY of: yes_female_nudity, yes_male_nudity, yes_sexual_activity, yes_sexual_intent >= 0.85
//
// On Hive errors: caller should quarantine (fail-safe — never deliver unscanned content).

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

function isFrameFlagged(classes: HiveClass[]): boolean {
  const classMap = new Map(classes.map((c) => [c.class_name, c.value]));
  const childPresent = (classMap.get('yes_child_present') ?? 0) >= CHILD_PRESENT_THRESHOLD;
  if (!childPresent) return false;
  return [...SEXUAL_CLASS_NAMES].some((name) => (classMap.get(name) ?? 0) >= SEXUAL_CONTENT_THRESHOLD);
}

// Accepts the R2 object key (not a URL) — generates a presigned URL internally.
export async function scanForCsam(r2Key: string): Promise<{ flagged: boolean }> {
  const presignedUrl = await getPresignedUrl(r2Key);

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
      body: JSON.stringify({ input: [{ media_url: presignedUrl }] }),
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
  // Empty output means Hive couldn't process the video — treat as scan failure, not clean.
  if (frames.length === 0) {
    throw new Error('Hive returned empty output — video could not be scanned');
  }
  const flagged = frames.some((frame) => isFrameFlagged(frame.classes ?? []));
  return { flagged };
}
