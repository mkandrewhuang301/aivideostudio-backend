// src/services/geminiImageService.ts
// Nano Banana (Gemini 3.1 Flash Image) mask-guided image edit for the Magic Editor, plus the
// Explainer illustrated tier's nano-motion frame edits.
//
// Nano has no alpha-mask parameter like OpenAI's /v1/images/edits — it is prompt-based. To honor
// the user's painted region we build a "guide": the source image with the edit region highlighted
// in a distinct color derived from the mask alpha, and instruct Nano to edit only there. The
// caller still runs compositeMaskedEdit() afterward, so the painted mask remains the hard boundary
// (this guide only steers WHERE Nano places the edit; it never widens what survives). Chosen over
// gpt-image-2 for ~4x lower cost and more surgical edits (2026-07-23 bakeoff — see project notes).
//
// Guardrails (2026-07-24, research: nano-scriptfirst-tts) on every nano call:
//   1. PROMPT — an explicit cardinality clause ("same number of instances of every element — do
//      not duplicate") targeting nano's observed draw-a-second-copy failure mode, plus an explicit
//      "same resolution and aspect ratio as the input" line.
//   2. CONFIG — generationConfig.imageConfig.{aspectRatio,imageSize} is set on every request. The
//      old code never sent it, so every call silently defaulted to 1:1/1K and the drift was
//      patched with a distorting fit:'fill' resize. Prompt asks, config enforces.
//   3. ASPECT TRIPWIRE — the returned image's aspect must match the input's within tolerance;
//      a mismatch retries once, then center-crops (never stretches) as the last resort.
//   4. NO-OP DETECTION (edit path) — if the returned frame is pixel-identical to the input, the
//      edit didn't take: retry once with a strengthened prompt, then return null so the caller
//      can skip the step (a crossfade between identical frames shows a fake "change" beat).

import sharp from 'sharp';
import { config } from '../config';

const GEMINI_IMAGE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// Highlight opacity over the edit region — enough for Nano to localize, light enough that it can
// still read the underlying content it is editing.
const GUIDE_ALPHA_SCALE = 0.4;

// Aspect ratios the Gemini image endpoint accepts for imageConfig.aspectRatio (Gemini 3.x list).
const SUPPORTED_ASPECTS: Array<{ id: string; ratio: number }> = [
  { id: '1:1', ratio: 1 },
  { id: '4:5', ratio: 4 / 5 },
  { id: '5:4', ratio: 5 / 4 },
  { id: '3:4', ratio: 3 / 4 },
  { id: '4:3', ratio: 4 / 3 },
  { id: '2:3', ratio: 2 / 3 },
  { id: '3:2', ratio: 3 / 2 },
  { id: '9:16', ratio: 9 / 16 },
  { id: '16:9', ratio: 16 / 9 },
  { id: '21:9', ratio: 21 / 9 },
];

/** Tolerance on aspect-ratio match (relative). 2% absorbs integer rounding, nothing more. */
const ASPECT_TOLERANCE = 0.02;
/**
 * No-op detection: an edit whose 32x32 downscaled frame has essentially zero pixels changed did
 * not apply. 0.5% of pixels above the per-pixel threshold is deliberately strict — a real edit
 * (even a subtle one like drifting smoke) moves far more than this at 32x32.
 */
const NO_OP_CHANGED_PIXEL_FRACTION = 0.005;
const NO_OP_PIXEL_THRESHOLD = 12; // per-channel abs diff (0-255) counting as "changed"
/** A base still whose channels are all near-constant is a blank/solid-color generation failure. */
const BLANK_STDDEV_THRESHOLD = 2;

/** Nearest supported aspect id for the given pixel dimensions (log-ratio distance). */
export function nearestSupportedAspect(width: number, height: number): string {
  const target = width / height;
  let best = SUPPORTED_ASPECTS[0]!;
  for (const candidate of SUPPORTED_ASPECTS) {
    if (Math.abs(Math.log(candidate.ratio / target)) < Math.abs(Math.log(best.ratio / target))) {
      best = candidate;
    }
  }
  return best.id;
}

/** imageConfig.imageSize tier for the given pixel dimensions (smallest tier >= the long side). */
export function imageSizeFor(width: number, height: number): string {
  const longSide = Math.max(width, height);
  if (longSide <= 1024) return '1K';
  if (longSide <= 2048) return '2K';
  return '4K';
}

function aspectMatches(w1: number, h1: number, w2: number, h2: number): boolean {
  return Math.abs(w1 / h1 - w2 / h2) / (w2 / h2) <= ASPECT_TOLERANCE;
}

export interface PixelDiffStats {
  /** Fraction of pixels (0-1) whose per-channel abs diff exceeds NO_OP_PIXEL_THRESHOLD. */
  changedFraction: number;
}

/**
 * Cheap change measurement between two same-ish images: downscale both to 32x32 and count pixels
 * that actually moved, in RGB (NOT grayscale — a pure-luminance-preserving chroma swap like
 * gray->red maps to nearly the same gray value and would read as a no-op). Used for no-op
 * detection and the soft % changed log line. Exported for unit tests.
 */
export async function pixelDiffStats(a: Buffer, b: Buffer): Promise<PixelDiffStats> {
  const SIZE = 32;
  const [rawA, rawB] = await Promise.all([
    sharp(a).resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
    sharp(b).resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
  ]);
  let changed = 0;
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    const dr = Math.abs(rawA[i * 3]! - rawB[i * 3]!);
    const dg = Math.abs(rawA[i * 3 + 1]! - rawB[i * 3 + 1]!);
    const db = Math.abs(rawA[i * 3 + 2]! - rawB[i * 3 + 2]!);
    if (dr > NO_OP_PIXEL_THRESHOLD || dg > NO_OP_PIXEL_THRESHOLD || db > NO_OP_PIXEL_THRESHOLD) {
      changed += 1;
    }
  }
  return { changedFraction: changed / (SIZE * SIZE) };
}

/**
 * Blank/solid-color detection for base stills: a failed image generation sometimes returns a
 * near-monochrome frame. Local sharp stats only — milliseconds, no network. Exported for the
 * illustrated stage's download check.
 */
export async function isBlankImage(buffer: Buffer): Promise<boolean> {
  const stats = await sharp(buffer).stats();
  return stats.channels.every((channel) => (channel.stdev ?? 0) < BLANK_STDDEV_THRESHOLD);
}

interface NanoCallOptions {
  aspectRatio: string;
  imageSize: string;
}

/** Shared fetch + response-parse for both nano entry points, with the imageConfig guardrail. */
async function callNanoEdit(
  imageBuffer: Buffer,
  prompt: string,
  options: NanoCallOptions,
): Promise<Buffer> {
  const response = await fetch(
    `${GEMINI_IMAGE_URL}/${config.nanoImageModel}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': config.geminiApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: 'image/png', data: imageBuffer.toString('base64') } },
            { text: prompt },
          ],
        }],
        // The ONLY lever that controls output pixels — "high resolution" in prompt text does
        // nothing (confirmed in Google's docs). Without this the call defaults to 1:1/1K.
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: options.aspectRatio, imageSize: options.imageSize },
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Nano image edit failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const json = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{
      inline_data?: { data?: string };
      inlineData?: { data?: string };
    }> } }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inline_data?.data ?? p.inlineData?.data);
  const data = imagePart?.inline_data?.data ?? imagePart?.inlineData?.data;
  if (!data) {
    throw new Error('Nano image edit returned no image');
  }
  return Buffer.from(data, 'base64');
}

/**
 * Brings a returned frame to the target dimensions WITHOUT distortion: exact match returns
 * as-is; same-aspect different-size plain-resizes; wrong aspect center-crops to the target aspect
 * first, then resizes (the old fit:'fill' stretch silently distorted wrong-aspect generations).
 */
async function conformToDimensions(buffer: Buffer, width: number, height: number): Promise<Buffer> {
  const meta = await sharp(buffer).metadata();
  if (meta.width === width && meta.height === height) return buffer;
  if (meta.width && meta.height && aspectMatches(meta.width, meta.height, width, height)) {
    return sharp(buffer).resize(width, height, { fit: 'fill' }).png().toBuffer();
  }
  return sharp(buffer).resize(width, height, { fit: 'cover', position: 'center' }).png().toBuffer();
}

/**
 * Builds the guided source: the original image with the edit region (mask alpha == 0, OpenAI's
 * "transparent = edit" convention) tinted bright green so Nano can see exactly where to edit.
 */
async function buildGuideImage(
  sourceBuffer: Buffer,
  maskBuffer: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  // Mask alpha: 0 = edit, 255 = keep. Negate so the edit region is opaque, then scale to the
  // highlight opacity → a 1-channel alpha that is ~102 over the edit region and 0 elsewhere.
  const highlightAlpha = await sharp(maskBuffer)
    .ensureAlpha()
    .extractChannel('alpha')
    .negate()
    .linear(GUIDE_ALPHA_SCALE, 0)
    .raw()
    .toBuffer();

  const greenRgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    greenRgb[i * 3] = 0;
    greenRgb[i * 3 + 1] = 255;
    greenRgb[i * 3 + 2] = 0;
  }
  const highlightLayer = await sharp(greenRgb, { raw: { width, height, channels: 3 } })
    .joinChannel(highlightAlpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();

  return sharp(sourceBuffer)
    .resize(width, height, { fit: 'fill' })
    .composite([{ input: highlightLayer, blend: 'over' }])
    .png()
    .toBuffer();
}

/**
 * Runs a mask-guided edit through Nano Banana and returns the raw generated image buffer. The
 * caller is responsible for compositing this into the exact painted mask region.
 */
export async function nanoImageEditWithMaskGuidance(
  sourceBuffer: Buffer,
  maskBuffer: Buffer,
  editInstruction: string,
  width: number,
  height: number,
): Promise<Buffer> {
  if (!config.geminiApiKey) {
    throw new Error('Magic Editor (nano) requires GEMINI_API_KEY');
  }
  const guide = await buildGuideImage(sourceBuffer, maskBuffer, width, height);
  const prompt =
    'The image has an area highlighted in bright green. Edit ONLY inside that green-highlighted ' +
    `area: ${editInstruction}. Do not add any green tint or highlight to your output — render ` +
    'natural colors and textures that blend with the surroundings. Keep everything outside the ' +
    'highlighted area exactly the same, and do not add, duplicate, or clone any element — every ' +
    'object in the scene appears the same number of times as in the original. Return the complete ' +
    'edited image at the same resolution and aspect ratio as the input.';

  const callOptions: NanoCallOptions = {
    aspectRatio: nearestSupportedAspect(width, height),
    imageSize: imageSizeFor(width, height),
  };

  // Aspect tripwire: one retry on a wrong-shape return, then center-crop as the last resort.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const edited = await callNanoEdit(guide, prompt, callOptions);
    const meta = await sharp(edited).metadata();
    if (meta.width && meta.height && !aspectMatches(meta.width, meta.height, width, height)) {
      if (attempt === 0) {
        console.warn(
          `[nano] mask edit returned ${meta.width}x${meta.height} for a ${width}x${height} target; retrying once`,
        );
        continue;
      }
      console.warn(`[nano] mask edit aspect mismatch after retry; center-cropping to ${width}x${height}`);
    }
    return conformToDimensions(edited, width, height);
  }
  throw new Error('unreachable');
}

/**
 * Surgical single-delta edit of a base still, no mask needed (nano-motion system, 2026-07-23).
 *
 * Returns null when nano persistently returns the image unchanged (a no-op edit): the caller
 * should SKIP that edit step rather than crossfade between identical frames (which reads as a
 * frozen "change" beat). A wrong-aspect or undersized return is conformed to the input dimensions
 * without distortion (center-crop, never stretch), since the illustrated-motion ffmpeg assembly
 * (xfade/concat) requires every frame in a scene's chain to share identical WxH.
 */
export async function nanoEditStill(baseImage: Buffer, editInstruction: string): Promise<Buffer | null> {
  if (!config.geminiApiKey) {
    throw new Error('Nano motion edit requires GEMINI_API_KEY');
  }
  const { width, height } = await sharp(baseImage).metadata();
  if (!width || !height) {
    throw new Error('Nano still edit could not read the base image dimensions');
  }

  // Positive instruction first (the caller's delta), then the cardinality clause targeting nano's
  // draw-a-second-copy failure mode — phrased as an invariant over EVERY element so it also holds
  // in multi-subject scenes where only one subject changes — then preservation, then resolution.
  const basePrompt =
    `${editInstruction}. Every person, object, and element in this scene appears the SAME number `
    + 'of times as in the original — do not add, duplicate, clone, or copy any element anywhere in '
    + 'the frame; only the one change described above happens. This is an illustration — keep the '
    + 'exact same art style, line weight, colors, and every other element and the background '
    + 'pixel-identical. Return the complete edited image at the same resolution and aspect ratio '
    + 'as the input.';

  const callOptions: NanoCallOptions = {
    aspectRatio: nearestSupportedAspect(width, height),
    imageSize: imageSizeFor(width, height),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = attempt === 0
      ? basePrompt
      : `IMPORTANT: a previous attempt returned the image essentially unchanged or at the wrong `
        + `shape. Apply this edit clearly and visibly, at the input's exact resolution and aspect `
        + `ratio: ${basePrompt}`;
    const edited = await callNanoEdit(baseImage, prompt, callOptions);

    const meta = await sharp(edited).metadata();
    const aspectOk = !!meta.width && !!meta.height && aspectMatches(meta.width, meta.height, width, height);
    const { changedFraction } = await pixelDiffStats(baseImage, edited);
    console.log(
      `[nano] edit attempt ${attempt + 1}: ${(changedFraction * 100).toFixed(1)}% of pixels changed`
      + (aspectOk ? '' : `, aspect ${meta.width}x${meta.height} vs target ${width}x${height}`),
    );

    const noOp = changedFraction < NO_OP_CHANGED_PIXEL_FRACTION;
    if ((noOp || !aspectOk) && attempt === 0) {
      console.warn(`[nano] edit ${noOp ? 'was a no-op' : 'returned the wrong aspect'}; retrying once with a strengthened prompt`);
      continue;
    }
    if (noOp) {
      console.warn('[nano] edit still a no-op after retry; caller should skip this edit step');
      return null;
    }
    return conformToDimensions(edited, width, height);
  }
  throw new Error('unreachable');
}
