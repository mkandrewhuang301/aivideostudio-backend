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
import type { ExplainerVisualMethod, FormatAspectRatio } from '../config/formats';
import { getGenerationPresignedUrl, uploadBufferToR2 } from './archivalService';
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

export const illustratedKenBurnsStage: VisualStage = {
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
      tempDir = await mkdtemp(path.join(tmpdir(), 'explainer-kenburns-'));
      const stillPath = path.join(tempDir, 'still.png');
      const outPath = path.join(tempDir, 'clip.mp4');
      await downloadToFile(stillUrl, stillPath);

      const args = buildKenBurnsArgs({
        stillPath,
        durationSeconds: input.narrationDurationSeconds,
        aspectRatio: input.aspectRatio,
        sceneIndex: input.sceneIndex,
        outPath,
      });
      await runFfmpeg(args);

      const clip = await readFile(outPath);
      const clipR2Key = `generations/${input.generationId}.scene${input.sceneIndex}.mp4`;
      await uploadBufferToR2(clip, clipR2Key, 'video/mp4');
      return { clipR2Key };
    } catch (error) {
      if (error instanceof SafeVisualStageError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Ken Burns render failed (${reason})`);
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  },
};

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
