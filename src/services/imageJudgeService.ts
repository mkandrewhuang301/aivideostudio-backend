// imageJudgeService.ts — VLM quality gate for explainer stills (2026-07-25 spec, locked same-day).
//
// Every fresh still (both tiers' base stills, content-class/flip fallback step stills) and every
// nano-edit after-frame is checked by gemini-3.5-flash via the native generativelanguage API
// (GEMINI_API_KEY — no Replicate queue, fractions of a cent per call, adds latency not queue
// contention). 2.5-flash was deprecated 2026-06-17; do NOT regress the model id.
//
// Rubric: brief match (subject/era/composition), garbled or unrequested text (the judge knows via
// on_image_text whether ANY text is expected, and exactly which string), visual artifacts, style
// consistency. Edit mode additionally checks the surgical edit transformed rather than pasted a
// new hero object, and left the rest of the frame alone.
//
// Policy: at most 1 regeneration per image (reason injected into a hardened prompt), then
// ACCEPT WHATEVER COMES BACK — fail-open always. Regenerations are rationed per generation
// (ceil(scene_count * 0.25), min 2 — see explainerGenerationWorker's regenBudget). The judge
// itself is also fail-open: any network/parse failure is a pass, so a judge outage can never
// block a generation.

import { config } from '../config';

const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const JUDGE_TIMEOUT_MS = 30_000;
/** Downscale stills before judging — the rubric never needs full-res, and smaller = faster/cheaper. */
const JUDGE_IMAGE_MAX_EDGE = 1024;

export interface JudgeStillContext {
  /** The scene brief the still was generated from (post-decoration prompt is fine). */
  visualPrompt: string;
  /** Exact on-image text the still must contain — absent means NO text is allowed. */
  onImageText?: string;
  /** Human style label ("Flat Vector") for the style-consistency check. */
  styleLabel?: string;
  /** 'fresh' = a new composition; 'edit' = a nano-edit after-frame (adds composition/edit checks). */
  mode: 'fresh' | 'edit';
  /** mode 'edit' only: the surgical instruction that produced this frame. */
  editStep?: string;
  /**
   * mode 'edit' only: the PRE-edit frame. When present the judge compares BEFORE vs AFTER —
   * without it the "nothing outside the edit changed" rule is unenforceable (2026-07-25: nano
   * redrew a wire lattice mid-sequence and single-frame judging couldn't see the warp).
   */
  baseImage?: Buffer;
}

export interface JudgeVerdict {
  pass: boolean;
  /** One concise sentence naming the single worst defect (present iff pass === false). */
  reason?: string;
}

/** Pure decision: regenerate only on an explicit fail with budget left. Exported for tests. */
export function shouldRegenerate(verdict: JudgeVerdict, budget: { remaining: number }): boolean {
  return !verdict.pass && budget.remaining > 0;
}

function textRuleFor(onImageText?: string): string {
  const trimmed = onImageText?.trim();
  return trimmed
    ? `The image must contain exactly this text, rendered legibly and spelled correctly: "${trimmed}". Any OTHER words, letters, or numbers anywhere are a defect.`
    : 'The image must contain NO text, words, letters, or numbers at all.';
}

function judgePromptFor(context: JudgeStillContext): string {
  const textRule = textRuleFor(context.onImageText);
  if (context.mode === 'edit') {
    const compareRule = context.baseImage
      ? '3. Compare image 2 (AFTER) against image 1 (BEFORE): ANY element outside the requested edit changed — structural lines, geometry, positions, or proportions of unchanged elements. Thin structures (wires, struts, railings, lattices) must keep their exact configuration.'
      : '3. Parts of the frame OUTSIDE the requested edit changed.';
    const header = context.baseImage
      ? 'You are a strict visual-quality judge for one frame of an explainer-video motion sequence. Image 1 is the frame BEFORE a surgical edit; image 2 is the same frame AFTER it.'
      : 'You are a strict visual-quality judge for one frame of an explainer-video motion sequence. This frame was produced by a surgical edit on the previous frame.';
    return [
      header,
      `EDIT REQUESTED: "${context.editStep ?? ''}"`,
      `TEXT RULE: ${textRule}`,
      '',
      'FAIL the frame if ANY of these hold:',
      '1. The requested change is missing or barely visible.',
      '2. The edit pasted a large new hero object over an otherwise intact scene (collage look) instead of transforming elements already in the frame.',
      compareRule,
      '4. Garbled, misspelled, or pseudo-text anywhere; or text violating the TEXT RULE.',
      '5. Obvious artifacts: mangled hands/faces, duplicated or fused objects, watermarks, borders.',
      '',
      'Reply with JSON only, no markdown: {"pass": true} or {"pass": false, "reason": "one concise sentence naming the single worst defect"}.',
    ].join('\n');
  }
  return [
    'You are a strict visual-quality judge for a still image in a narrated explainer video. Judge it against the brief and the rules below.',
    `BRIEF: ${context.visualPrompt}`,
    `ART STYLE: ${context.styleLabel ?? 'the established illustration style'}`,
    `TEXT RULE: ${textRule}`,
    '',
    'FAIL the image if ANY of these hold:',
    '1. Subject, era, or composition does not match the brief.',
    '2. Garbled, misspelled, or pseudo-text anywhere; or text violating the TEXT RULE.',
    '3. Obvious artifacts: mangled hands/faces, duplicated or fused objects, watermarks, borders, or collage-like pasted elements.',
    '4. Wrong art style vs the ART STYLE above.',
    '',
    'Reply with JSON only, no markdown: {"pass": true} or {"pass": false, "reason": "one concise sentence naming the single worst defect"}.',
  ].join('\n');
}

/**
 * Retry prompt for a rejected fresh still: the original generation prompt plus the judge's reason
 * as an explicit avoid-this directive.
 */
export function hardenedStillPrompt(originalPrompt: string, reason: string): string {
  return `${originalPrompt}\n\nIMPORTANT: A previous attempt at this image was rejected for the `
    + `following reason: ${reason} Make sure the new image does not have that defect.`;
}

/** Retry prompt for a rejected nano edit: keep it surgical, name the defect to avoid. */
export function hardenedEditPrompt(editStep: string, reason: string): string {
  return `${editStep} (A previous attempt was rejected for: ${reason} — avoid that. Apply ONLY `
    + 'the requested change and keep everything else in the frame identical.)';
}

function parseVerdict(raw: string): JudgeVerdict | null {
  const content = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.pass !== 'boolean') return null;
    if (parsed.pass) return { pass: true };
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : 'unspecified quality defect';
    return { pass: false, reason };
  } catch {
    return null;
  }
}

/**
 * Judges one still or edit frame. FAIL-OPEN by contract: network errors, non-OK responses,
 * missing/malformed completions, and disabled config all return { pass: true } — the judge is a
 * quality gate, never a single point of failure.
 */
export async function judgeStill(image: Buffer, context: JudgeStillContext): Promise<JudgeVerdict> {
  if (!config.imageJudgeEnabled || !config.geminiApiKey) return { pass: true };
  try {
    // Downscale for the judge call (sharp is already a dependency of the image pipeline).
    const { default: sharp } = await import('sharp');
    const toJudgeJpeg = (buf: Buffer) => sharp(buf)
      .resize(JUDGE_IMAGE_MAX_EDGE, JUDGE_IMAGE_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const resized = await toJudgeJpeg(image);
    const baseResized = context.baseImage ? await toJudgeJpeg(context.baseImage) : null;

    const imageParts = [
      ...(baseResized ? [{ inline_data: { mime_type: 'image/jpeg', data: baseResized.toString('base64') } }] : []),
      { inline_data: { mime_type: 'image/jpeg', data: resized.toString('base64') } },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${GEMINI_API_ROOT}/models/${encodeURIComponent(config.imageJudgeModel)}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': config.geminiApiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                ...imageParts,
                { text: judgePromptFor(context) },
              ],
            }],
            generationConfig: { temperature: 0 },
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        console.warn(`[image-judge] API ${response.status}; passing (fail-open)`);
        return { pass: true };
      }
      const json = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = json.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('') ?? '';
      const verdict = parseVerdict(text);
      if (!verdict) {
        console.warn('[image-judge] unparseable verdict; passing (fail-open)');
        return { pass: true };
      }
      return verdict;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.warn('[image-judge] error; passing (fail-open):', error instanceof Error ? error.message : error);
    return { pass: true };
  }
}
