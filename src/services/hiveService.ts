// src/services/hiveService.ts
// Hive Moderation CSAM scan for completed generation videos.
// Called AFTER archiveToR2() in the webhook handler — uses the R2 public URL.
// API: Hive v3 Visual Moderation (POST /api/v3/hive/visual-moderation, Bearer auth)
//
// CSAM flag logic: flag the video if ANY frame has BOTH:
//   - yes_child_present >= 0.8
//   - ANY of: general_nsfw, yes_female_nudity, yes_male_nudity, yes_sexual_activity, yes_sexual_intent >= 0.85
//
// On Hive errors: caller should quarantine (fail-safe — never deliver unscanned content).

import { config } from '../config';

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

const CHILD_PRESENT_THRESHOLD = 0.8;
const SEXUAL_CONTENT_THRESHOLD = 0.85;
const SEXUAL_CLASS_NAMES = new Set([
  'general_nsfw',
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

export async function scanForCsam(r2Url: string): Promise<{ flagged: boolean }> {
  const response = await fetch('https://api.thehive.ai/api/v3/hive/visual-moderation', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.hiveApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: [{ media_url: r2Url }] }),
  });

  if (!response.ok) {
    throw new Error(`Hive API error: ${response.status}`);
  }

  const data = (await response.json()) as HiveVisualModerationResponse;
  const flagged = (data.output ?? []).some((frame) => isFrameFlagged(frame.classes ?? []));
  return { flagged };
}
