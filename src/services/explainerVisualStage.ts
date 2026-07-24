// src/services/explainerVisualStage.ts
//
// The swappable per-scene VISUAL generation stage for the Explainer pipeline (Explainer Tiers,
// 2026-07-22 build plan). Both visual methods implement the SAME interface, so the orchestrator
// (explainerGenerationWorker.ts) stays method-agnostic (CLAUDE.md rule 6 — provider abstraction).
// Which method runs is chosen per-generation by the LOCKED CONTRACT's `visual_method` field.
//
//   illustrated — gpt-image-2-low still (style anchor + visual_prompt) -> a SUBTLE ffmpeg
//                 Ken-Burns pan/zoom, rendered to a clip of EXACTLY the scene's narration
//                 duration. No Omni. Fills any duration by design (no freeze possible) — cheap,
//                 many short beats.
//   animated    — gpt-image-2-low still -> Omni (image-to-video) animates it, clamped to Omni's
//                 [3,10]s window (clamp lives in omniService.animateScene). This is today's
//                 worker logic, minus the retired 3-candidate vision-pick — exactly one still is
//                 generated now, so there is nothing left to pick between.
//
// Supersedes the stale gpt_animate/omni_oneshot Cast-aware scaffold. Cast (recurring characters)
// and SFX are OUT OF SCOPE for v1 — see the build plan's "Out of scope" section.

import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { motionClassOf, type ExplainerVisualMethod, type FormatAspectRatio, type SceneMotion } from '../config/formats';
import { getGenerationPresignedUrl, uploadBufferToR2 } from './archivalService';
import { nanoEditStill } from './geminiImageService';
import { animateScene } from './omniService';
import { generateStyledStill } from './providers/ReplicateProvider';

const execFileAsync = promisify(execFile);
const STILL_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Re-exported so callers only need to import from this one seam. */
export type VisualMethod = ExplainerVisualMethod;

export interface VisualStageInput {
  generationId: string;
  sceneIndex: number;
  /** Scene composition prompt (reserves the caption text_zone; never depicts a narrator). */
  visualPrompt: string;
  /** Motion/animation intent — read only by the animated stage. */
  motionPrompt: string;
  /** Presigned style-anchor image URL (the <IMAGE_REF_0> style reference). */
  styleAnchorUrl: string;
  /** SERVER-ONLY provider model ids, config-driven so provider hosting stays swappable. */
  imageModel: string;
  omniModel: string;
  /** Real narration-stem duration for this scene, in seconds. */
  narrationDurationSeconds: number;
  aspectRatio: FormatAspectRatio;
  /**
   * Illustrated-tier-only motion treatment (nano-motion system, 2026-07-23). Read only by the
   * illustrated stage; absent/undefined falls back to ken_burns. The animated stage ignores this
   * entirely — it keeps reading motionPrompt for Omni.
   */
  motion?: SceneMotion;
  /**
   * Set by explainerMotionAllocator.allocateMotionBudget: whether this scene's nano motion type
   * was granted budget. Ignored for free motions (ken_burns/wiggle) and by the animated stage.
   * Defaults to false (downgraded) when omitted, so callers that don't run the allocator still get
   * a safe, budget-free result.
   */
  resolvedNano?: boolean;
}

export interface VisualStageResult {
  /** Archived scene clip (mp4) in R2. */
  clipR2Key: string;
}

/** The single contract both visual methods implement. */
export interface VisualStage {
  readonly method: VisualMethod;
  /** Generate + archive one scene's clip, sized to input.narrationDurationSeconds. */
  generateSceneClip(input: VisualStageInput): Promise<VisualStageResult>;
}

class SafeVisualStageError extends Error {}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STILL_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new SafeVisualStageError(`Ken Burns still download failed (${response.status})`);
    }
    await writeFile(destPath, Buffer.from(await response.arrayBuffer()));
  } finally {
    clearTimeout(timer);
  }
}

async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', args);
}

// ─── Illustrated tier: gpt-image-2-low still -> ffmpeg Ken-Burns ───────────────────────────────

const KEN_BURNS_CANVAS: Record<FormatAspectRatio, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
};

const KEN_BURNS_FPS = 25;
// SUBTLE, deliberately small — a still-per-beat video must never read as a slideshow. Gentle
// enough that baked-in on-screen title text near the frame edges is never cropped by the zoom.
// Env-overridable so pacing/crop can be tuned without a code change.
const KEN_BURNS_MAX_ZOOM = Number(process.env.KEN_BURNS_MAX_ZOOM ?? 1.05);
// Drift fraction of frame width/height, kept well inside the zoom margin so the pan can never
// expose an edge of the source image.
const KEN_BURNS_DRIFT_FRAC = Number(process.env.KEN_BURNS_DRIFT_FRAC ?? 0.02);

export interface KenBurnsArgsInput {
  stillPath: string;
  durationSeconds: number;
  aspectRatio: FormatAspectRatio;
  /** Alternates pan direction scene-to-scene so a run of clips doesn't all drift the same way. */
  sceneIndex: number;
  outPath: string;
}

/**
 * PURE argv builder for the Illustrated tier's Ken-Burns clip: a single gpt-image-2 still,
 * looped and slowly zoomed/panned via zoompan into a clip of EXACTLY `durationSeconds`. No Omni —
 * this is what lets the Illustrated tier fill any beat length by design (no freeze possible,
 * unlike an Omni clip clamped to [3,10]s). Center-anchored zoom with a small alternating drift.
 */
export function buildKenBurnsArgs(input: KenBurnsArgsInput): string[] {
  const { stillPath, durationSeconds, aspectRatio, sceneIndex, outPath } = input;
  const { width, height } = KEN_BURNS_CANVAS[aspectRatio] ?? KEN_BURNS_CANVAS['9:16'];
  const safeDuration = Math.max(0.1, durationSeconds);
  const frames = Math.max(1, Math.round(safeDuration * KEN_BURNS_FPS));
  const zoomIncrement = (KEN_BURNS_MAX_ZOOM - 1) / frames;
  const dirX = sceneIndex % 2 === 0 ? 1 : -1;
  const dirY = sceneIndex % 3 === 0 ? -1 : 1;

  const zoomExpr = `min(zoom+${zoomIncrement.toFixed(8)},${KEN_BURNS_MAX_ZOOM})`;
  const xExpr = `(iw-iw/zoom)/2+${dirX}*(on/${frames})*iw*${KEN_BURNS_DRIFT_FRAC}`;
  const yExpr = `(ih-ih/zoom)/2+${dirY}*(on/${frames})*ih*${KEN_BURNS_DRIFT_FRAC}`;

  // Upscale 2x before zoompan so the zoom/crop always has real source pixels to sample from
  // (zoompan reads from the filtered frame, not the original still).
  const filter = [
    `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
    `crop=${width * 2}:${height * 2}`,
    `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${frames}:s=${width}x${height}:fps=${KEN_BURNS_FPS}`,
    'setsar=1',
  ].join(',');

  return [
    '-y',
    '-loop', '1',
    '-i', stillPath,
    '-t', String(safeDuration),
    '-vf', filter,
    '-r', String(KEN_BURNS_FPS),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    outPath,
  ];
}

// ─── Illustrated tier motion system (nano-motion execution plan, 2026-07-23) ───────────────────
//
// Nano gives ONE primitive: given a base still + an edit prompt, return the next frame with only
// the described delta changed. The four nano motion types (reaction, before_after,
// progressive_reveal, ambient_life) chain 1-3 of these edits into frames, then buildMotionSequenceArgs
// assembles them into a clip via ffmpeg xfade. ken_burns and wiggle are free (0 nano) and use their
// own pure ffmpeg-only builders below.

const WIGGLE_FPS = 25;
// ~±1.5° amplitude in radians (0.026 rad ≈ 1.49°), matching the Motion mechanic reference.
const WIGGLE_AMPLITUDE_RAD = Number(process.env.WIGGLE_AMPLITUDE_RAD ?? 0.026);
const WIGGLE_FREQUENCY_HZ = Number(process.env.WIGGLE_FREQUENCY_HZ ?? 0.375);
// Overscan factor before rotating so the small sine rotation never exposes a canvas edge; the
// final crop back to the target canvas size only samples the safely-covered center.
const WIGGLE_UPSCALE = Number(process.env.WIGGLE_UPSCALE ?? 1.2);

export interface WiggleArgsInput {
  stillPath: string;
  durationSeconds: number;
  aspectRatio: FormatAspectRatio;
  outPath: string;
}

/**
 * PURE argv builder for the `wiggle` free motion: a single still gently sine-rotated ±1.5° around
 * its center, for a playful character beat with no real content change. No nano — mirrors
 * buildKenBurnsArgs's shape (single-still loop, one output).
 */
export function buildWiggleArgs(input: WiggleArgsInput): string[] {
  const { stillPath, durationSeconds, aspectRatio, outPath } = input;
  const { width, height } = KEN_BURNS_CANVAS[aspectRatio] ?? KEN_BURNS_CANVAS['9:16'];
  const safeDuration = Math.max(0.1, durationSeconds);
  const upscaledWidth = Math.round(width * WIGGLE_UPSCALE);
  const upscaledHeight = Math.round(height * WIGGLE_UPSCALE);

  const angleExpr = `${WIGGLE_AMPLITUDE_RAD}*sin(2*PI*t*${WIGGLE_FREQUENCY_HZ})`;
  const filter = [
    `scale=${upscaledWidth}:${upscaledHeight}:force_original_aspect_ratio=increase`,
    `crop=${upscaledWidth}:${upscaledHeight}`,
    `rotate=${angleExpr}:c=none:ow=${upscaledWidth}:oh=${upscaledHeight}`,
    `crop=${width}:${height}`,
    'setsar=1',
  ].join(',');

  return [
    '-y',
    '-loop', '1',
    '-i', stillPath,
    '-t', String(safeDuration),
    '-vf', filter,
    '-r', String(WIGGLE_FPS),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    outPath,
  ];
}

export type MotionSequencePattern = 'reaction' | 'before_after' | 'progressive_reveal' | 'ambient_life';

const MOTION_SEQUENCE_FPS = 25;
// Crossfade duration per pattern, per the Motion mechanic reference: reaction is a quick dissolve,
// before_after a touch slower, progressive_reveal quick additive fades, ambient_life a slow subtle
// crossfade.
const MOTION_CROSSFADE_SECONDS: Record<MotionSequencePattern, number> = {
  reaction: 0.15,
  before_after: 0.2,
  progressive_reveal: 0.1,
  ambient_life: 0.5,
};

export interface MotionSequenceArgsInput {
  /** frame[0] = base still, frame[1..N] = chained nano edits, in playback order. */
  framePaths: string[];
  pattern: MotionSequencePattern;
  durationSeconds: number;
  aspectRatio: FormatAspectRatio;
  outPath: string;
}

/**
 * PURE argv builder assembling a chain of nano-edited still frames into one scene clip of EXACTLY
 * `durationSeconds`, via ffmpeg's xfade filter (hold each frame, crossfade into the next).
 *
 * Segments are equal-length; the pattern only changes the crossfade length. Derivation: xfade's
 * documented output duration is `d0 + d1 - crossfadeDuration` per pair, so chaining k equal
 * segments of length `segDur` with (k-1) crossfades of length `cd` yields a total output duration
 * of `k*segDur - (k-1)*cd`. Solving for segDur so that total equals `durationSeconds` gives
 * `segDur = (durationSeconds + (k-1)*cd) / k`. Each xfade's `offset` (where in the running,
 * already-merged stream the next crossfade begins) is the accumulated duration of the stream so
 * far minus `cd` — this is the standard chained-xfade formula.
 */
export function buildMotionSequenceArgs(input: MotionSequenceArgsInput): string[] {
  const { framePaths, pattern, durationSeconds, aspectRatio, outPath } = input;
  const { width, height } = KEN_BURNS_CANVAS[aspectRatio] ?? KEN_BURNS_CANVAS['9:16'];
  const safeDuration = Math.max(0.1, durationSeconds);
  const frameCount = Math.max(1, framePaths.length);

  if (frameCount === 1) {
    // Degenerate case (no nano edits actually produced a second frame) — just hold the one frame,
    // no xfade needed.
    return [
      '-y', '-loop', '1', '-i', framePaths[0]!,
      '-t', String(safeDuration),
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`,
      '-r', String(MOTION_SEQUENCE_FPS),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      outPath,
    ];
  }

  // cd is clamped well below segDur so every segment stays long enough to supply the crossfade
  // overlap on both sides — protects very short narration beats from a degenerate/negative
  // segment length.
  const configuredCd = MOTION_CROSSFADE_SECONDS[pattern];
  const cd = Math.min(configuredCd, Math.max(0.02, safeDuration / (frameCount * 4)));
  const segDur = (safeDuration + (frameCount - 1) * cd) / frameCount;

  const args: string[] = ['-y'];
  framePaths.forEach((framePath) => {
    args.push('-loop', '1', '-t', segDur.toFixed(6), '-i', framePath);
  });

  const filterParts: string[] = [];
  framePaths.forEach((_framePath, i) => {
    filterParts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${MOTION_SEQUENCE_FPS}[v${i}]`,
    );
  });

  let previousLabel = 'v0';
  let accumulatedDuration = segDur;
  for (let i = 1; i < frameCount; i += 1) {
    const isLast = i === frameCount - 1;
    const outLabel = isLast ? 'vout' : `x${i}`;
    const offset = accumulatedDuration - cd;
    filterParts.push(
      `[${previousLabel}][v${i}]xfade=transition=fade:duration=${cd.toFixed(6)}:offset=${offset.toFixed(6)}[${outLabel}]`,
    );
    previousLabel = outLabel;
    accumulatedDuration += segDur - cd;
  }

  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[vout]');
  args.push('-r', String(MOTION_SEQUENCE_FPS));
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath);

  return args;
}

// ─── Motion-class-aware plan resolution (2026-07-23 design correction) ─────────────────────────
//
// nano is a PIXEL-PRESERVATION primitive, not the only way to show a change. edit_budget therefore
// never decides WHETHER a scene's transformation renders — only whether it gets the premium
// pixel-locked nano version or a cheaper fallback. The fallback differs by SceneMotionClass:
//   'content'    (before_after, progressive_reveal) -> independent gpt stills per step, assembled
//                the SAME way as nano frames (hold/crossfade). The transformation still shows.
//   'semi'       (reaction)       -> wiggle (stays lively, just not a literal pose change).
//   'decorative' (ambient_life)   -> ken_burns (the only class that ever goes static).
//   'free'       (ken_burns, wiggle) -> unaffected either way.

export type MotionPlan =
  | { kind: 'ken_burns' }
  | { kind: 'wiggle' }
  /** Premium path: nano chains edit_steps off the base still, preserving every untouched pixel. */
  | { kind: 'nano'; pattern: MotionSequencePattern; editSteps: string[] }
  /** Content-class fallback: each step is an INDEPENDENT full-composition gpt still, not a nano
   *  delta — loses pixel-lock, keeps the transformation. Never counted against edit_budget. */
  | { kind: 'gpt_stills'; pattern: MotionSequencePattern; editSteps: string[] };

/**
 * PURE decision function: given a scene's motion plan and whether the allocator granted it nano
 * budget, decides which rendering path this scene actually takes. No motion at all -> ken_burns
 * (older data / reused animated-tier scene). Exported for unit testing without any I/O.
 */
export function resolveMotionPlan(motion: SceneMotion | undefined, resolvedNano: boolean): MotionPlan {
  if (!motion) return { kind: 'ken_burns' };
  if (motion.type === 'wiggle') return { kind: 'wiggle' };
  if (motion.type === 'ken_burns') return { kind: 'ken_burns' };

  // A nano-eligible type (reaction/before_after/progressive_reveal/ambient_life).
  if (resolvedNano) {
    return { kind: 'nano', pattern: motion.type, editSteps: motion.edit_steps };
  }
  const motionClass = motionClassOf(motion.type);
  if (motionClass === 'content') {
    return { kind: 'gpt_stills', pattern: motion.type, editSteps: motion.edit_steps };
  }
  if (motionClass === 'semi') return { kind: 'wiggle' };
  return { kind: 'ken_burns' }; // 'decorative' (ambient_life unbudgeted)
}

export const illustratedStage: VisualStage = {
  method: 'illustrated',
  async generateSceneClip(input: VisualStageInput): Promise<VisualStageResult> {
    const stillKey = await generateStyledStill(
      input.visualPrompt,
      input.styleAnchorUrl,
      input.imageModel,
      `${input.generationId}.scene${input.sceneIndex}.still`,
    );
    const stillUrl = await getGenerationPresignedUrl(stillKey);

    let tempDir: string | undefined;
    try {
      tempDir = await mkdtemp(path.join(tmpdir(), 'explainer-motion-'));
      const stillPath = path.join(tempDir, 'still.png');
      const outPath = path.join(tempDir, 'clip.mp4');
      await downloadToFile(stillUrl, stillPath);

      const plan = resolveMotionPlan(input.motion, input.resolvedNano ?? false);

      let args: string[];
      if (plan.kind === 'wiggle') {
        args = buildWiggleArgs({
          stillPath,
          durationSeconds: input.narrationDurationSeconds,
          aspectRatio: input.aspectRatio,
          outPath,
        });
      } else if (plan.kind === 'ken_burns') {
        args = buildKenBurnsArgs({
          stillPath,
          durationSeconds: input.narrationDurationSeconds,
          aspectRatio: input.aspectRatio,
          sceneIndex: input.sceneIndex,
          outPath,
        });
      } else if (plan.kind === 'nano') {
        // Premium path: chain edit_steps off the base still into frame files (each edit preserves
        // every pixel the prompt didn't call out), then assemble with the xfade sequence builder.
        const framePaths = [stillPath];
        // Buffer.from(...) normalizes the Buffer<ArrayBuffer> type param (readFile vs sharp's
        // toBuffer() inside nanoEditStill can otherwise infer incompatible Buffer generics).
        let currentImage: Buffer = Buffer.from(await readFile(stillPath));
        for (let stepIndex = 0; stepIndex < plan.editSteps.length; stepIndex += 1) {
          const edited = await nanoEditStill(currentImage, plan.editSteps[stepIndex]!);
          const framePath = path.join(tempDir, `frame${stepIndex + 1}.png`);
          await writeFile(framePath, edited);
          framePaths.push(framePath);
          currentImage = Buffer.from(edited);
        }
        args = buildMotionSequenceArgs({
          framePaths,
          pattern: plan.pattern,
          durationSeconds: input.narrationDurationSeconds,
          aspectRatio: input.aspectRatio,
          outPath,
        });
      } else {
        // Content-class fallback (no nano budget): each step becomes its own INDEPENDENT full
        // still via generateStyledStill — a fresh composition describing the scene's cumulative
        // state at that step, not a nano delta. Still shows the full transformation, just without
        // pixel-lock between frames. Does not touch nanoEditStill or count against edit_budget.
        const framePaths = [stillPath];
        let cumulativePrompt = input.visualPrompt;
        for (let stepIndex = 0; stepIndex < plan.editSteps.length; stepIndex += 1) {
          cumulativePrompt = `${cumulativePrompt} Then: ${plan.editSteps[stepIndex]}`;
          const stepStillKey = await generateStyledStill(
            cumulativePrompt,
            input.styleAnchorUrl,
            input.imageModel,
            `${input.generationId}.scene${input.sceneIndex}.step${stepIndex + 1}`,
          );
          const stepStillUrl = await getGenerationPresignedUrl(stepStillKey);
          const framePath = path.join(tempDir, `frame${stepIndex + 1}.png`);
          await downloadToFile(stepStillUrl, framePath);
          framePaths.push(framePath);
        }
        args = buildMotionSequenceArgs({
          framePaths,
          pattern: plan.pattern,
          durationSeconds: input.narrationDurationSeconds,
          aspectRatio: input.aspectRatio,
          outPath,
        });
      }
      await runFfmpeg(args);

      const clip = await readFile(outPath);
      const clipR2Key = `generations/${input.generationId}.scene${input.sceneIndex}.mp4`;
      await uploadBufferToR2(clip, clipR2Key, 'video/mp4');
      return { clipR2Key };
    } catch (error) {
      if (error instanceof SafeVisualStageError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Illustrated motion render failed (${reason})`);
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  },
};

/** @deprecated Alias for illustratedStage — kept so any existing import of the old name still works. */
export const illustratedKenBurnsStage: VisualStage = illustratedStage;

// ─── Animated tier: gpt-image-2-low still -> Omni image-to-video ───────────────────────────────

export const animatedOmniStage: VisualStage = {
  method: 'animated',
  async generateSceneClip(input: VisualStageInput): Promise<VisualStageResult> {
    const stillKey = await generateStyledStill(
      input.visualPrompt,
      input.styleAnchorUrl,
      input.imageModel,
      `${input.generationId}.scene${input.sceneIndex}.still`,
    );
    const stillUrl = await getGenerationPresignedUrl(stillKey);
    const clip = await animateScene(
      stillUrl,
      input.motionPrompt,
      input.omniModel,
      input.aspectRatio,
      input.narrationDurationSeconds,
      input.generationId,
      input.sceneIndex,
    );
    return { clipR2Key: clip.r2Key };
  },
};

export function resolveVisualStage(method: VisualMethod): VisualStage {
  return method === 'illustrated' ? illustratedKenBurnsStage : animatedOmniStage;
}
