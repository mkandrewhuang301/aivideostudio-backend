// src/queue/ffmpegProcessor.ts
// Real I/O for the ffmpeg post-process stage (D-06): downloads the job's R2 input(s) into a
// scoped temp dir, shells out to the ffmpeg binary via execFile with a fixed argv array (never a
// shell string — T-09.3-03: untrusted generationId/keys must never allow path traversal or shell
// injection), uploads the resulting MP4 back to R2, and returns the new canonical r2Key.
//
// Split out of ffmpegWorker.ts so that file's BullMQ lifecycle + completion-rejoin logic can be
// unit tested by mocking this module as a single seam, without any live ffmpeg binary, network
// fetch, or R2 credentials in the test process.

import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Upload } from '@aws-sdk/lib-storage';
import { r2, R2_BUCKET } from '../storage/r2';
import { getGenerationPresignedUrl } from '../services/archivalService';
import { buildAssFile, buildTextOverlayAss } from '../services/assCaptionBuilder';
import type {
  FfmpegJobData,
  ComposeSpec,
  ComposeFilterSpec,
  ExplainerComposeSpec,
  SummaryComposeSpec,
  SummarySourceFraming,
  SpeedCurvePoint,
} from './ffmpegWorker';
import { buildAdjustmentCube, isIdentityAdjustment } from '../config/adjustmentLut';

const execFileAsync = promisify(execFile);

async function downloadR2KeyToFile(r2Key: string, destPath: string): Promise<void> {
  const url = await getGenerationPresignedUrl(r2Key);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ffmpeg input ${r2Key}: ${response.status}`);
  }
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    createWriteStream(destPath),
  );
}

async function uploadFileToR2(localPath: string, r2Key: string): Promise<void> {
  const upload = new Upload({
    client: r2,
    params: {
      Bucket: R2_BUCKET,
      Key: r2Key,
      Body: createReadStream(localPath),
      ContentType: 'video/mp4',
    },
  });
  await upload.done();
}

// T-09.3-03: argv array only — never interpolate a raw key/path into a shell string.
async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', args);
}

// Phase 13 (Edit Studio) — 'compose' op support (plan 06). ---------------------------------------

// 13-RESEARCH.md Open Question 3 (RESOLVED via 13-UI-SPEC.md): export always hard-caps at 1080p
// regardless of source clip resolution, keyed off the project's chosen aspect ratio.
const COMPOSE_CANVAS: Record<'9:16' | '4:5' | '1:1' | '16:9', { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '4:5': { width: 1080, height: 1350 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
};

// h264 requires even width/height — the fixed presets above are already even, but a clip's raw
// probed pixel dimensions (the 'original' aspect ratio path) can be odd.
function forceEven(n: number): number {
  return n % 2 === 0 ? n : n - 1;
}

/**
 * Resolves the 1080p-capped canvas WxH for a compose spec's aspect ratio. Plan 13-22 B2:
 * 'original' resolves to the spec's originalCanvasWidth/Height (the first clip's stored pixel
 * dimensions, computed at snapshot-build time), forced to even numbers; falls back to the 9:16
 * canvas (1080x1920) when those dimensions are unknown.
 */
export function resolveComposeCanvas(
  spec: Pick<ComposeSpec, 'aspectRatio' | 'originalCanvasWidth' | 'originalCanvasHeight'>,
): { width: number; height: number } {
  if (spec.aspectRatio === 'original') {
    if (spec.originalCanvasWidth && spec.originalCanvasHeight) {
      return { width: forceEven(spec.originalCanvasWidth), height: forceEven(spec.originalCanvasHeight) };
    }
    return { width: 1080, height: 1920 };
  }
  return COMPOSE_CANVAS[spec.aspectRatio] ?? COMPOSE_CANVAS['9:16'];
}

export interface BuildComposeArgsInput {
  spec: ComposeSpec;
  /** Local temp-file paths for spec.clips, same order/length as spec.clips. */
  clipPaths: string[];
  /** Local temp-file paths for spec.audioClips, same order/length as spec.audioClips. */
  audioPaths: string[];
  /** Path to a generated .ass caption file, or null when spec.captionCues is empty. */
  assPath: string | null;
  /** Path to a generated Text-overlay .ass file (G4), or null when spec.textOverlays is empty. */
  textOverlayAssPath: string | null;
  fontsDir: string;
  /** Directory holding the generated .cube pack (assets/luts). Only read when spec.filters is non-empty. */
  lutsDir: string;
  /**
   * Directory where THIS job's adjustment-generated .cube files were already written (2026-08-02
   * Adjust tab) — the caller must write one file per adjustment-carrying filter row via
   * `buildAdjustmentCube` BEFORE calling this function, at `adjustment-${rowIndex}.cube` under
   * this directory (runFfmpegOp does this using the job's own temp dir). This function itself
   * stays pure — it only emits the `lut3d=file=` path, it never touches the filesystem. Defaults
   * to `lutsDir` when omitted, which is harmless since that default is only ever consulted for
   * rows that carry no `adjustments`.
   */
  adjustmentCubesDir?: string;
  outPath: string;
}

export interface SpeedSegment {
  sourceStart: number;
  sourceEnd: number;
  renderedStart: number;
  renderedEnd: number;
  rate: number;
}

function normalizedPlaybackRate(rate: number | null | undefined): number {
  if (rate == null || !Number.isFinite(rate)) return 1;
  return Math.min(Math.max(rate, 0.1), 10);
}

/**
 * Canonical speed-curve normalization. The iOS composition builder intentionally mirrors this
 * exact contract so preview, timeline math, and server export use the same safe curve.
 */
export function normalizedSpeedCurve(
  points: SpeedCurvePoint[] | null | undefined,
): SpeedCurvePoint[] | null {
  if (!points || points.length < 2) return null;
  const sorted = points
    .filter((point) => Number.isFinite(point.position) && Number.isFinite(point.rate))
    .map((point) => ({
      position: Math.min(Math.max(point.position, 0), 1),
      rate: normalizedPlaybackRate(point.rate),
    }))
    .sort((a, b) => a.position - b.position);

  const deduplicated: SpeedCurvePoint[] = [];
  for (const point of sorted) {
    const last = deduplicated.at(-1);
    if (last && Math.abs(last.position - point.position) < 0.0001) {
      deduplicated[deduplicated.length - 1] = point;
    } else {
      deduplicated.push(point);
    }
  }
  if (deduplicated.length < 2) return null;
  if (deduplicated[0].position > 0) {
    deduplicated.unshift({ position: 0, rate: deduplicated[0].rate });
  } else {
    deduplicated[0].position = 0;
  }
  const last = deduplicated[deduplicated.length - 1];
  if (last.position < 1) {
    deduplicated.push({ position: 1, rate: last.rate });
  } else {
    last.position = 1;
  }
  return deduplicated;
}

/**
 * Piecewise-constant approximation of a linearly-interpolated curve. Sixteen source slices per
 * clip keeps the graph bounded while looking smooth; this exact midpoint sampling rule is shared
 * with EditorCompositionBuilder on iOS.
 */
export function speedSegments(
  sourceDuration: number,
  playbackRate = 1,
  speedCurve?: SpeedCurvePoint[] | null,
): SpeedSegment[] {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) return [];
  const curve = normalizedSpeedCurve(speedCurve);
  if (!curve) {
    const rate = normalizedPlaybackRate(playbackRate);
    return [{
      sourceStart: 0,
      sourceEnd: sourceDuration,
      renderedStart: 0,
      renderedEnd: sourceDuration / rate,
      rate,
    }];
  }

  const segments: SpeedSegment[] = [];
  let renderedCursor = 0;
  for (let pointIndex = 0; pointIndex < curve.length - 1; pointIndex++) {
    const lower = curve[pointIndex];
    const upper = curve[pointIndex + 1];
    const fractionSpan = upper.position - lower.position;
    if (fractionSpan <= 0) continue;
    const subdivisions = Math.max(1, Math.ceil(fractionSpan * 16));
    for (let subdivision = 0; subdivision < subdivisions; subdivision++) {
      const localStart = subdivision / subdivisions;
      const localEnd = (subdivision + 1) / subdivisions;
      const fractionStart = lower.position + fractionSpan * localStart;
      const fractionEnd = lower.position + fractionSpan * localEnd;
      const midpoint = (localStart + localEnd) / 2;
      const rate = normalizedPlaybackRate(lower.rate + (upper.rate - lower.rate) * midpoint);
      const sourceStart = fractionStart * sourceDuration;
      const sourceEnd = fractionEnd * sourceDuration;
      const renderedDuration = (sourceEnd - sourceStart) / rate;
      segments.push({
        sourceStart,
        sourceEnd,
        renderedStart: renderedCursor,
        renderedEnd: renderedCursor + renderedDuration,
        rate,
      });
      renderedCursor += renderedDuration;
    }
  }
  return segments;
}

function renderedClipDuration(clip: ComposeSpec['clips'][number]): number {
  const sourceDuration = Math.max(0, clip.trimEndSeconds - clip.trimStartSeconds);
  return speedSegments(sourceDuration, clip.playbackRate, clip.speedCurve).at(-1)?.renderedEnd ?? 0;
}

/** ffmpeg's atempo accepts 0.5...2.0 per stage, so extreme 0.1x...10x rates need chaining. */
export function atempoChain(rate: number): string {
  let remaining = normalizedPlaybackRate(rate);
  const factors: number[] = [];
  while (remaining < 0.5 - 1e-9) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  while (remaining > 2 + 1e-9) {
    factors.push(2);
    remaining /= 2;
  }
  factors.push(remaining);
  return factors.map((factor) => `atempo=${factor.toFixed(6)}`).join(',');
}

function filterNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/** Aspect-fit followed by per-clip scale/position and a crop back to the project canvas. */
function clipCanvasFilter(
  width: number,
  height: number,
  requestedScale?: number,
  requestedXNorm?: number,
  requestedYNorm?: number,
): string {
  const scale = Math.min(Math.max(requestedScale ?? 1, 0.25), 4);
  const xNorm = Math.min(Math.max(requestedXNorm ?? 0.5, 0), 1);
  const yNorm = Math.min(Math.max(requestedYNorm ?? 0.5, 0), 1);
  const dx = filterNumber((xNorm - 0.5) * width);
  const dy = filterNumber((yNorm - 0.5) * height);
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `scale=iw*${filterNumber(scale)}:ih*${filterNumber(scale)}`,
    `pad=w='max(iw,${width})+2*abs(${dx})':h='max(ih,${height})+2*abs(${dy})':x='(ow-iw)/2+${dx}':y='(oh-ih)/2+${dy}':color=black`,
    `crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`,
    'setsar=1',
  ].join(',');
}

/**
 * How far the project's audio runs past its last video frame, in seconds — 0 whenever the video is
 * the longest thing in the project (the common case).
 *
 * Mirrors iOS `EditorState.videoEndSeconds` / `audioEndSeconds` exactly, and must keep mirroring
 * them: the editor's preview and this export are independent renderers of the same project, and
 * the 20.1 mix bug was preview-only precisely because of that independence. Deliberately counts
 * every audio clip, including muted ones, for the same reason the client does — muting must not
 * change the project's length.
 */
export function audioTailSeconds(spec: ComposeSpec): number {
  // No clips means the synthesized black segment was already built to the full audio length —
  // padding on top of that would double-count the tail and produce a file twice as long.
  if (spec.clips.length === 0) return 0;
  const videoEnd = spec.clips.reduce(
    (sum, clip) => sum + renderedClipDuration(clip),
    0,
  );
  return Math.max(0, audioEndSeconds(spec) - videoEnd);
}

/** Latest trailing edge across every audio clip — mirrors iOS `EditorState.audioEndSeconds`. */
export function audioEndSeconds(spec: ComposeSpec): number {
  return spec.audioClips.reduce(
    (latest, audio) =>
      Math.max(latest, audio.startOffsetSeconds + Math.max(0, audio.trimEndSeconds - audio.trimStartSeconds)),
    0,
  );
}

/**
 * Escapes a path for use inside a filter_complex argument, where `:` separates options and `\`
 * escapes. Filter paths here are server-controlled (assets/luts + a catalog-validated id), so this
 * is belt-and-braces rather than a live injection concern.
 */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * Fixed-point formatting for a number embedded in a filter expression. Guards against exponential
 * notation (`1e-7`), which ffmpeg's expression parser does not accept, and against the long
 * float tails that make a generated graph impossible to eyeball in a test failure.
 */
function filterNum(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3).replace(/\.?0+$/, '') || '0' : '0';
}

/**
 * Chains the project's color filters onto `inLabel` and returns the label carrying the result.
 *
 * Shape per filter, verified against ffmpeg 2026-08-01:
 *
 *   [in]split[keep][fx];
 *   [fx]lut3d=file=P:interp=tetrahedral:enable='between(t,S,E)'[graded];
 *   [graded][keep]blend=all_mode=normal:all_opacity=I[out]
 *
 * Two non-obvious details, both of which were wrong on the first attempt and caught by rendering
 * actual frames:
 *
 *  1. `blend`'s FIRST input is the TOP layer. `[keep][graded]` (the intuitive reading) outputs the
 *     UNGRADED frame at full opacity — the filter silently does nothing.
 *  2. The `enable` belongs on the `lut3d`, NOT on the `blend`. A disabled multi-input filter passes
 *     through its first input, which here is the graded branch — so putting `enable` on the blend
 *     applies the grade for the whole video and drops it inside the window, exactly inverted.
 *     With `enable` on the lut3d, outside the window both branches are the same pixels and the
 *     blend is a no-op by construction.
 *
 * At full intensity the split/blend pair is skipped entirely: `lut3d` alone carries the `enable`,
 * which is the common case and keeps the graph small.
 *
 * 2026-08-02 (Adjust tab): a row can now resolve to ONE cube (a bundled look OR an adjustment
 * stack) or TWO chained in series (a look with adjustment tweaks on top — project_filters'
 * "both set" case). Each row still contributes exactly one `enable`/intensity gate around
 * whichever cube(s) it resolves to; every cube inside that gate carries its own `enable` too
 * (multi-input `lut3d` passthrough is per-filter, not per-chain), so a two-cube row can't leak
 * grading past its window on the inner stage.
 */
function appendFilterChain(
  filterParts: string[],
  inLabel: string,
  filters: ComposeFilterSpec[],
  lutsDir: string,
  adjustmentCubesDir: string,
): string {
  let label = inLabel;

  filters.forEach((filter, index) => {
    const start = Math.max(0, filter.startOffsetSeconds);
    const end = start + Math.max(0, filter.durationSeconds);
    // A zero-length filter would produce an `enable` that is never true — skip it rather than
    // emit a dead branch that still costs a full LUT pass per frame.
    if (end <= start) return;

    const intensity = Math.min(Math.max(filter.intensity ?? 1, 0), 1);
    if (intensity <= 0) return;

    // The bundled look's cube (if any) grades first, so "a look with tweaks on top" reads exactly
    // as the name says — adjustments act on what the look produced, not the other way round.
    const lutPaths: string[] = [];
    if (filter.filterId) {
      lutPaths.push(path.join(lutsDir, `${filter.filterId}.cube`));
    }
    if (filter.adjustments && !isIdentityAdjustment(filter.adjustments)) {
      lutPaths.push(path.join(adjustmentCubesDir, `adjustment-${index}.cube`));
    }
    // Neither a resolvable filterId nor a non-identity adjustment stack — mirrors the
    // zero-length/zero-intensity skips above rather than emitting a dead pass-through branch.
    if (lutPaths.length === 0) return;

    const enable = `enable='between(t,${filterNum(start)},${filterNum(end)})'`;
    const out = `vfilt${index}`;

    // Applies every cube this row resolved to, in series, onto `srcLabel`. Each stage carries its
    // own `enable` — see the doc comment above — and only the LAST stage's output takes `dstLabel`.
    const applyLutsInSeries = (srcLabel: string, dstLabel: string): void => {
      let cur = srcLabel;
      lutPaths.forEach((lutPath, lutIndex) => {
        const lut = escapeFilterPath(lutPath);
        const isLast = lutIndex === lutPaths.length - 1;
        const stageOut = isLast ? dstLabel : `${dstLabel}s${lutIndex}`;
        filterParts.push(`[${cur}]lut3d=file=${lut}:interp=tetrahedral:${enable}[${stageOut}]`);
        cur = stageOut;
      });
    };

    if (intensity >= 0.999) {
      applyLutsInSeries(label, out);
    } else {
      const keep = `fkeep${index}`;
      const fx = `ffx${index}`;
      const graded = `fgraded${index}`;
      filterParts.push(`[${label}]split[${keep}][${fx}]`);
      applyLutsInSeries(fx, graded);
      filterParts.push(
        `[${graded}][${keep}]blend=all_mode=normal:all_opacity=${filterNum(intensity)}[${out}]`,
      );
    }
    label = out;
  });

  return label;
}

/**
 * Pure function: assembles the FULL ffmpeg argv array for the compose op (RESEARCH.md Pattern 1/2)
 * — never a shell string (T-13-11). Concatenates mixed-resolution/mixed-media clips via a single
 * filter_complex scale+pad+concat graph (NEVER the `-f concat` demuxer — Pitfall 2), chains a
 * libass `ass=` pass for Text overlays (G4 — replaces the old per-overlay `drawtext` loop, which
 * couldn't rotate and ignored scale), optionally burns word-level captions via a second `ass=`
 * pass, and mixes independently-timed audio clips over the concatenated clip audio via
 * `adelay`/`amix`. Text overlays are chained BEFORE captions, so captions render on top if the
 * two ever visually overlap (matches the pre-existing caption-on-top precedence).
 */
export function buildComposeArgs(input: BuildComposeArgsInput): string[] {
  const { spec, clipPaths, audioPaths, assPath, textOverlayAssPath, fontsDir, lutsDir, outPath } = input;
  const adjustmentCubesDir = input.adjustmentCubesDir ?? lutsDir;
  const { width, height } = resolveComposeCanvas(spec);

  const args: string[] = ['-y'];
  const filterParts: string[] = [];

  // 2026-07-27: a project with audio but NO video clips is valid (deleting the last clip no longer
  // collapses the project — see the audio-outlives-video note). It exports as an mp4 that is black
  // for its whole length, which is exactly what the editor already previews there. Synthesized as
  // ONE lavfi black segment + a silent audio partner, so the graph below stays the ordinary
  // n-segment concat instead of growing a second shape: `concat=n=` must never see zero.
  const blackOnlyDuration = spec.clips.length === 0 ? audioEndSeconds(spec) : 0;
  if (spec.clips.length === 0) {
    if (blackOnlyDuration <= 0) {
      // Nothing to render and nothing to hear. Fail loudly here rather than emit a zero-length
      // file that would surface downstream as a corrupt-looking export.
      throw new Error('compose: project has no clips and no audio — nothing to export');
    }
    args.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${blackOnlyDuration.toFixed(3)}`);
    filterParts.push(`[0:v]setpts=PTS-STARTPTS,setsar=1[v0]`);
    filterParts.push(
      `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${blackOnlyDuration.toFixed(3)}[a0]`,
    );
  }

  // Per-clip video/audio input args + normalize (trim/scale/pad) filter chains.
  spec.clips.forEach((clip, i) => {
    const clipPath = clipPaths[i];
    const sourceDuration = Math.max(0, clip.trimEndSeconds - clip.trimStartSeconds);
    const segments = speedSegments(sourceDuration, clip.playbackRate, clip.speedCurve);
    const duration = segments.at(-1)?.renderedEnd ?? 0;
    if (clip.mediaType === 'image') {
      // No native duration/audio track on a still image — loop it for the clip's trim duration
      // and synthesize a silent audio stream so concat's a=1 (uniform audio-stream-per-input
      // requirement) stays satisfied alongside the real video clips.
      args.push('-loop', '1', '-t', String(duration), '-i', clipPath);
      filterParts.push(
        `[${i}:v]setpts=PTS-STARTPTS,${clipCanvasFilter(width, height, clip.scale, clip.xNorm, clip.yNorm)}[v${i}]`,
      );
      filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100:duration=${duration}[a${i}]`);
    } else {
      args.push('-i', clipPath);
      const volume = Math.min(Math.max(clip.volume ?? 1, 0), 1);
      const hasAdjustedSpeed =
        normalizedSpeedCurve(clip.speedCurve) !== null
        || Math.abs(normalizedPlaybackRate(clip.playbackRate) - 1) > 0.000001;
      if (!hasAdjustedSpeed) {
        // Preserve the pre-speed graph exactly for legacy/default jobs.
        filterParts.push(
          `[${i}:v]trim=start=${clip.trimStartSeconds}:end=${clip.trimEndSeconds},setpts=PTS-STARTPTS,${clipCanvasFilter(width, height, clip.scale, clip.xNorm, clip.yNorm)}[v${i}]`,
        );
        filterParts.push(
          `[${i}:a]atrim=start=${clip.trimStartSeconds}:end=${clip.trimEndSeconds},asetpts=PTS-STARTPTS,volume=${volume}[a${i}]`,
        );
        return;
      }
      segments.forEach((segment, segmentIndex) => {
        const sourceStart = clip.trimStartSeconds + segment.sourceStart;
        const sourceEnd = clip.trimStartSeconds + segment.sourceEnd;
        filterParts.push(
          `[${i}:v]trim=start=${filterNumber(sourceStart)}:end=${filterNumber(sourceEnd)},setpts=(PTS-STARTPTS)/${filterNumber(segment.rate)},${clipCanvasFilter(width, height, clip.scale, clip.xNorm, clip.yNorm)}[v${i}s${segmentIndex}]`,
        );
        filterParts.push(
          `[${i}:a]atrim=start=${filterNumber(sourceStart)}:end=${filterNumber(sourceEnd)},asetpts=PTS-STARTPTS,${atempoChain(segment.rate)},volume=${volume}[a${i}s${segmentIndex}]`,
        );
      });
      const speedConcatInputs = segments
        .map((_, segmentIndex) => `[v${i}s${segmentIndex}][a${i}s${segmentIndex}]`)
        .join('');
      filterParts.push(
        `${speedConcatInputs}concat=n=${segments.length}:v=1:a=1[v${i}][a${i}]`,
      );
    }
  });

  // Independent audio clip inputs — indexed AFTER every video input, which is the synthesized
  // black segment (input 0) when the project has no clips of its own.
  const videoSegmentCount = spec.clips.length === 0 ? 1 : spec.clips.length;
  const audioInputBase = videoSegmentCount;
  spec.audioClips.forEach((audioClip, j) => {
    args.push('-i', audioPaths[j]);
    const inputIndex = audioInputBase + j;
    const delayMs = Math.max(0, Math.round(audioClip.startOffsetSeconds * 1000));
    // Phase 20.1: per-clip DAW gain (defaults to 1 = original level) — lets a disabled-then-
    // re-enabled stem mix at < full volume; muted originals are already excluded upstream by the
    // enabled filter, so this never double-counts.
    filterParts.push(
      `[${inputIndex}:a]atrim=start=${audioClip.trimStartSeconds}:end=${audioClip.trimEndSeconds},asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1,volume=${audioClip.gain ?? 1}[aud${j}]`,
    );
  });

  // Concat every clip's normalized video+audio pair into one base stream.
  const concatInputs = Array.from({ length: videoSegmentCount }, (_, i) => `[v${i}][a${i}]`).join('');
  filterParts.push(`${concatInputs}concat=n=${videoSegmentCount}:v=1:a=1[vconcat][aconcat]`);

  let videoLabel = 'vconcat';

  // Color filters, BEFORE any burn-in. A grade applies to the footage, not to the user's text and
  // captions — chaining these after the `ass=` passes would tint the lettering along with the
  // picture, which is not what any editor does and not what the picker preview shows.
  videoLabel = appendFilterChain(filterParts, videoLabel, spec.filters ?? [], lutsDir, adjustmentCubesDir);

  // Burn Text overlays via the generated ASS file (G4's buildTextOverlayAss) — native rotation
  // (\frz) + scale (\fs), unlike the old drawtext loop this replaces.
  if (textOverlayAssPath && spec.textOverlays.length > 0) {
    filterParts.push(`[${videoLabel}]ass=filename=${textOverlayAssPath}:fontsdir=${fontsDir}[vtext]`);
    videoLabel = 'vtext';
  }

  // Burn word-level captions via the generated ASS file (13-05's assCaptionBuilder), if present.
  if (assPath && spec.captionCues.length > 0) {
    filterParts.push(`[${videoLabel}]ass=filename=${assPath}:fontsdir=${fontsDir}[vout]`);
    videoLabel = 'vout';
  }

  // Mix independently-timed audio clips over the concatenated clip audio.
  //
  // 2026-07-27 (~/.planning/notes/2026-07-27-audio-outlives-video.md): `duration=longest`, not
  // `duration=first`. `first` is `[aconcat]` — the CLIPS' own audio — so any audio clip outliving
  // the video was silently truncated to the video's length, which is exactly the compression the
  // rule forbids. When nothing outlives the video the two are equivalent ([aconcat] IS the
  // longest), so this only changes the case it's meant to.
  let audioLabel = 'aconcat';
  if (spec.audioClips.length > 0) {
    const amixInputs = ['[aconcat]', ...spec.audioClips.map((_, j) => `[aud${j}]`)].join('');
    filterParts.push(
      `${amixInputs}amix=inputs=${spec.audioClips.length + 1}:duration=longest:dropout_transition=0[amixed]`,
    );
    audioLabel = 'amixed';
  }

  // Pad the VIDEO with black to match, or the mix above would run past the last frame and ffmpeg
  // would end the file at the video's length anyway — preview and export have to agree that the
  // project got longer. Applied AFTER the ass burns so overlay/caption timings are untouched:
  // they're timed against the real video and have nothing to say about the tail.
  //
  // The `fps=30` is LOAD-BEARING, not cosmetic: by this point the chain has gone through
  // trim -> setpts=PTS-STARTPTS -> concat, which leaves the link with no usable frame-rate
  // metadata, so tpad spaces its pad frames wrong and the encoder then DROPS most of them
  // (observed: a 4.000s tail rendered as 1.1s — 210 frames generated, 87 dropped, video track
  // ending at 4.1s while the audio ran the full 7.0s). The container duration still reads
  // correct in that state because the AUDIO track sets it, which is why this is invisible to
  // both an argv-construction test and a naive format=duration probe — it only shows up when
  // probing the VIDEO stream. Normalizing the rate before tpad is what makes the pad survive;
  // `fps=30` matches the summary-compose path's existing convention. Must stay BEFORE tpad
  // (after it, the frames are already lost).
  const tailSeconds = audioTailSeconds(spec);
  if (tailSeconds > 0) {
    filterParts.push(
      `[${videoLabel}]fps=30,tpad=stop_mode=add:stop_duration=${tailSeconds.toFixed(3)}:color=black[vpad]`,
    );
    videoLabel = 'vpad';
  }

  // The ENTIRE filter graph is one argv element — never interpolated into a shell command (T-13-11).
  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', `[${videoLabel}]`, '-map', `[${audioLabel}]`);
  args.push('-c:v', 'libx264', '-c:a', 'aac', outPath);

  return args;
}

export interface BuildExplainerComposeArgsInput {
  spec: ExplainerComposeSpec;
  clipPaths: string[];
  narrationPath: string;
  musicPath: string | null;
  captionAssPath: string;
  fontsDir: string;
  outPath: string;
}

// Morph transitions (nano-motion execution plan, 2026-07-23): a true xfade would overlap adjacent
// clips and shorten the total video below the narration+music timeline (drift). Per the plan's
// explicit "sync > fancy" guidance, morph is instead a fade-out/fade-in DIP that costs zero
// timeline time — narration and music stay untouched, only the two clips' own video streams gain
// a brief fade at the cut, which reads far softer than a hard cut without any offset math.
// 2026-07-24 by-ear pass: the dip fades to the illustrated tier's signature CREAM, not black —
// three dips-to-black in a 37s video read as blinks; a cream dip reads as an intentional
// page-turn. (fade's `color` option; black remains the filter default for every other caller.)
const MORPH_FADE_SECONDS = 0.3;
const MORPH_FADE_COLOR = '0xf7f2e7'; // flat-vector cream background

/** Clamp the fade so it never exceeds a clip too short to hold it — never goes negative/overlaps. */
function morphFadeDurationFor(clipDurationSeconds: number): number {
  return Math.min(MORPH_FADE_SECONDS, Math.max(0.05, clipDurationSeconds / 4));
}

/**
 * Pure argv builder for Explainer assembly. Scene clips are already animated/motion-rendered;
 * each input is trimmed to its measured narration duration, and only its video stream enters the
 * graph. Guard: when no clip declares `transition: 'morph'`, this produces the EXACT same argv as
 * before the nano-motion system existed — 'cut' (including when `transition` is omitted) never
 * changes the filter graph.
 */
export function buildExplainerComposeArgs(input: BuildExplainerComposeArgsInput): string[] {
  const { spec, clipPaths, narrationPath, musicPath, captionAssPath, fontsDir, outPath } = input;
  const args: string[] = ['-y'];
  const filterParts: string[] = [];

  spec.clips.forEach((clip, i) => {
    args.push('-t', String(clip.durationSeconds), '-i', clipPaths[i]);

    // fadeOut: THIS clip transitions into the next as 'morph' -> fade its own tail to cream.
    const fadeOutDur = morphFadeDurationFor(clip.durationSeconds);
    const fadeOut = clip.transition === 'morph' && i < spec.clips.length - 1
      ? `,fade=t=out:st=${Math.max(0, clip.durationSeconds - fadeOutDur).toFixed(6)}:d=${fadeOutDur.toFixed(6)}:color=${MORPH_FADE_COLOR}`
      : '';
    // fadeIn: the PRECEDING clip transitioned into this one as 'morph' -> fade this clip's own
    // head in from cream.
    const previousClip = i > 0 ? spec.clips[i - 1] : undefined;
    const fadeInDur = morphFadeDurationFor(clip.durationSeconds);
    const fadeIn = previousClip?.transition === 'morph'
      ? `,fade=t=in:st=0:d=${fadeInDur.toFixed(6)}:color=${MORPH_FADE_COLOR}`
      : '';

    filterParts.push(
      `[${i}:v]scale=${spec.width}:${spec.height}:force_original_aspect_ratio=increase,crop=${spec.width}:${spec.height},setsar=1${fadeIn}${fadeOut}[v${i}]`,
    );
  });

  const narrationInputIndex = spec.clips.length;
  args.push('-i', narrationPath);

  const musicInputIndex = narrationInputIndex + 1;
  if (musicPath) {
    args.push('-stream_loop', '-1', '-i', musicPath);
  }

  const concatInputs = spec.clips.map((_, i) => `[v${i}]`).join('');
  filterParts.push(`${concatInputs}concat=n=${spec.clips.length}:v=1:a=0[vconcat]`);

  let audioMap = `${narrationInputIndex}:a`;
  if (musicPath) {
    filterParts.push(`[${musicInputIndex}:a]volume=${spec.musicVolume}[bed]`);
    // normalize=0 keeps narration at FULL volume (amix's default normalize=1 would halve every
    // input) so the voice stays dominant and the music sits quietly underneath at musicVolume.
    filterParts.push(
      `[${narrationInputIndex}:a][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
    );
    audioMap = '[aout]';
  }

  filterParts.push(`[vconcat]ass=filename=${captionAssPath}:fontsdir=${fontsDir}[vout]`);

  // The complete graph is one execFile argv element (T-14-07); no shell command is constructed.
  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[vout]', '-map', audioMap);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outPath);

  return args;
}

export interface BuildSummaryComposeArgsInput {
  spec: SummaryComposeSpec;
  sourcePath: string;
  narrationPath: string;
  musicPath: string | null;
  captionAssPath: string;
  fontsDir: string;
  outPath: string;
}

/** Minimum frame aspect preserved inside the square window when framing is `balanced`. */
const SUMMARY_BALANCED_ASPECT = 4 / 3;

/**
 * Video-window sizing for one summary clip.
 *
 * A landscape canvas fills edge to edge. A square window — the whole canvas on 1:1, the square on
 * 9:16 — honours `sourceFraming`: `fill` crops the source to a hard square (a 16:9 source loses
 * ~44% of its width), while `balanced`/`fit` crop less and letterbox the remainder INSIDE the
 * square, so more of each scene survives.
 *
 * On PORTRAIT the square is placed `portraitSquareTopPx` from the canvas top (default centered),
 * biased upward so the black band BELOW it can hold captions clear of the footage — a bright or
 * dark scene never fights the text. Horizontal placement is always centered.
 */
export function buildSummarySizingFilter(
  spec: Pick<SummaryComposeSpec, 'width' | 'height'> & {
    sourceFraming?: SummarySourceFraming;
    portraitSquareTopPx?: number;
  },
): string {
  const { width, height } = spec;
  if (width > height) {
    return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  }

  const square = width;
  const framing = spec.sourceFraming ?? 'fill';
  const windowFilter = framing === 'fill'
    ? `scale=${square}:${square}:force_original_aspect_ratio=increase,crop=${square}:${square}`
    : [
      // `fit` never crops. `balanced` crops only down to SUMMARY_BALANCED_ASPECT and no further —
      // the min() pair leaves a source already narrower than that aspect completely untouched.
      ...(framing === 'fit'
        ? []
        : [`crop='min(iw,ih*${SUMMARY_BALANCED_ASPECT})':'min(ih,iw/${SUMMARY_BALANCED_ASPECT})'`]),
      `scale=${square}:${square}:force_original_aspect_ratio=decrease`,
      `pad=${square}:${square}:(ow-iw)/2:(oh-ih)/2:color=black`,
    ].join(',');

  if (height <= width) return windowFilter;
  // Undefined keeps the old centered placement (symbolic, byte-identical to legacy payloads);
  // a set value clamps so the square always fits and lifts it toward the top.
  const topPad = spec.portraitSquareTopPx == null
    ? '(oh-ih)/2'
    : String(Math.max(0, Math.min(height - square, Math.round(spec.portraitSquareTopPx))));
  return `${windowFilter},pad=${width}:${height}:(ow-iw)/2:${topPad}:color=black`;
}

/**
 * Cuts every timestamp range from one episode input, retimes each range to its narration beat,
 * places a centered square edit inside portrait output (or fills non-portrait canvases), then
 * concatenates and mixes narration with an optional original music bed.
 */
export function buildSummaryComposeArgs(input: BuildSummaryComposeArgsInput): string[] {
  const { spec, sourcePath, narrationPath, musicPath, captionAssPath, fontsDir, outPath } = input;
  // Lanczos over swscale's bilinear default: every summary rescales its source into a 1080-wide
  // window, and a sub-1080p upload is upscaled outright — the default visibly softens both.
  const args: string[] = [
    '-y', '-sws_flags', 'lanczos+accurate_rnd+full_chroma_int',
    '-i', sourcePath, '-i', narrationPath,
  ];
  const filterParts: string[] = [];
  const sourceLabels = spec.clips.map((_, index) => `[src${index}]`).join('');
  filterParts.push(`[0:v]split=${spec.clips.length}${sourceLabels}`);

  const sizingFilter = buildSummarySizingFilter(spec);
  spec.clips.forEach((clip, index) => {
    const sourceDuration = Math.max(0.1, clip.endSeconds - clip.startSeconds);
    const outputDuration = Math.max(0.1, clip.outputDurationSeconds);
    const ptsScale = outputDuration / sourceDuration;
    filterParts.push(
      `[src${index}]trim=start=${clip.startSeconds}:end=${clip.endSeconds},setpts=${ptsScale}*(PTS-STARTPTS),fps=30,${sizingFilter},setsar=1[v${index}]`,
    );
  });

  filterParts.push(`${spec.clips.map((_, index) => `[v${index}]`).join('')}concat=n=${spec.clips.length}:v=1:a=0[vconcat]`);
  filterParts.push(`[vconcat]ass=filename=${captionAssPath}:fontsdir=${fontsDir}[vout]`);

  if (musicPath) {
    args.push('-stream_loop', '-1', '-i', musicPath);
  }
  const musicInputIndex = '2:a';

  let audioMap = '1:a';
  const diegeticWindows = spec.diegeticWindows ?? [];
  if (diegeticWindows.length > 0) {
    // "Let the clip breathe" (2026-07-25 spec): the original footage audio ([0:a]) plays at full
    // volume during each diegetic window, layered under the (silent-there) narration track and
    // the optional music bed. normalize=0 (already used by buildExplainerComposeArgs above) keeps
    // every input at its own full volume — amix's default normalize=1 would otherwise attenuate
    // the diegetic audio right when it's supposed to carry the moment.
    const diegeticLabels = diegeticWindows.map((window, index) => {
      const label = `dieg${index}`;
      const sourceStart = Math.max(0, window.sourceClipStartSec);
      const sourceEnd = Math.max(sourceStart, window.sourceClipEndSec);
      const delayMs = Math.max(0, Math.round(window.startSec * 1000));
      filterParts.push(
        `[0:a]atrim=start=${sourceStart}:end=${sourceEnd},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[${label}]`,
      );
      return `[${label}]`;
    });

    const bedLabel = musicPath ? '[bed]' : null;
    if (bedLabel) filterParts.push(`[${musicInputIndex}]volume=${spec.musicVolume}${bedLabel}`);

    const mixInputs = ['[1:a]', ...(bedLabel ? [bedLabel] : []), ...diegeticLabels];
    filterParts.push(
      `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0[aout]`,
    );
    audioMap = '[aout]';
  } else if (musicPath) {
    filterParts.push(`[${musicInputIndex}]volume=${spec.musicVolume}[bed]`);
    filterParts.push('[1:a][bed]amix=inputs=2:duration=first:dropout_transition=0[aout]');
    audioMap = '[aout]';
  }

  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[vout]', '-map', audioMap);
  // Explicit rate control instead of libx264's CRF 23 default: the source is re-encoded exactly
  // once here, and outlined caption edges plus anime flat-colour gradients are what CRF 23 spends
  // its bit budget on last. CRF 18 is visually transparent at this resolution.
  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    // Episode rips routinely carry a QT chapter/data track. Without these it rides through into
    // the cut, keeping the SOURCE's full duration — so the container advertises a 24-minute file
    // for a 60-second recap and players size their scrubber from that, not from the real streams.
    '-dn', '-map_chapters', '-1',
    '-movflags', '+faststart', outPath,
  );
  return args;
}

/**
 * Downloads inputs, runs the mux or concat ffmpeg command, uploads the result to R2, and returns
 * the final r2Key (`generations/${generationId}.mp4`) plus, for mux ops, the preserved silent
 * master key (`generations/${generationId}.silent.mp4`). Always cleans up the temp dir, even on
 * error — the caller (processFfmpegJob) lets BullMQ's retry/final-failure handling take over.
 */
export async function runFfmpegOp(data: FfmpegJobData): Promise<{ r2Key: string; masterR2Key?: string }> {
  const { generationId, inputR2Keys, audioR2Key, op } = data;
  // T-09.3-03: only ever write under os.tmpdir()/ffmpeg-${generationId}-* — scoped to this job.
  const tempDir = await mkdtemp(path.join(tmpdir(), `ffmpeg-${generationId}-`));

  try {
    const outPath = path.join(tempDir, 'out.mp4');

    if (op === 'mux') {
      if (!audioR2Key) throw new Error('ffmpeg mux op requires audioR2Key');
      const clipPath = path.join(tempDir, 'clip.mp4');
      const audioPath = path.join(tempDir, 'audio.m4a');
      await downloadR2KeyToFile(inputR2Keys[0], clipPath);
      // D-04: preserve the pre-mux (silent) clip at a distinct key BEFORE muxing, so the
      // canonical generations/${id}.mp4 key can be safely overwritten by the muxed output below
      // without clobbering the swappable silent source the future editor phase re-muxes from.
      const masterR2Key = `generations/${generationId}.silent.mp4`;
      await uploadFileToR2(clipPath, masterR2Key);
      await downloadR2KeyToFile(audioR2Key, audioPath);
      await runFfmpeg([
        '-y', '-i', clipPath, '-i', audioPath,
        '-map', '0:v', '-map', '1:a', '-shortest',
        '-c:v', 'copy', '-c:a', 'aac', outPath,
      ]);
      const r2Key = `generations/${generationId}.mp4`;
      await uploadFileToR2(outPath, r2Key);
      return { r2Key, masterR2Key };
    } else if (op === 'compose') {
      // Phase 13 (Edit Studio) SC7 — real server-side export render. Reads EXCLUSIVELY from
      // `data.compose` (the enqueue-time snapshot) — never re-queries any project_* table
      // (RESEARCH.md Pitfall 4 / T-13-14): a user may keep editing the (still-editable-per-D-12)
      // project while this job runs, and the export must reflect what they saw at export time,
      // not a live/half-edited read.
      const spec = data.compose;
      if (!spec) throw new Error('ffmpeg compose op requires data.compose');

      const clipPaths: string[] = [];
      for (let i = 0; i < spec.clips.length; i++) {
        const clip = spec.clips[i];
        const ext = clip.r2Key.split('.').pop() || (clip.mediaType === 'image' ? 'jpg' : 'mp4');
        const clipPath = path.join(tempDir, `clip${i}.${ext}`);
        await downloadR2KeyToFile(clip.r2Key, clipPath);
        clipPaths.push(clipPath);
      }

      const audioPaths: string[] = [];
      for (let j = 0; j < spec.audioClips.length; j++) {
        const audioClip = spec.audioClips[j];
        const ext = audioClip.r2Key.split('.').pop() || 'm4a';
        const audioPath = path.join(tempDir, `audio${j}.${ext}`);
        await downloadR2KeyToFile(audioClip.r2Key, audioPath);
        audioPaths.push(audioPath);
      }

      const canvas = resolveComposeCanvas(spec);

      let textOverlayAssPath: string | null = null;
      if (spec.textOverlays.length > 0) {
        const textOverlayAssContents = buildTextOverlayAss(spec.textOverlays, canvas);
        textOverlayAssPath = path.join(tempDir, 'textOverlays.ass');
        await writeFile(textOverlayAssPath, textOverlayAssContents, 'utf-8');
      }

      let assPath: string | null = null;
      if (spec.captionCues.length > 0) {
        const assContents = buildAssFile(spec.captionCues, spec.captionStyle, canvas);
        assPath = path.join(tempDir, 'captions.ass');
        await writeFile(assPath, assContents, 'utf-8');
      }

      // Bundled TTF (13-02), resolved relative to process cwd (repo root at Railway runtime) —
      // never depends on system fontconfig being present/configured (RESEARCH.md Pitfall 1).
      const fontsDir = path.resolve('assets/fonts');
      // Generated .cube pack, resolved the same cwd-relative way as the fonts above.
      const lutsDir = path.resolve('assets/luts');

      // 2026-08-02 Adjust tab: an adjustment row has no static .cube in assets/luts — its table is
      // parameters, compiled fresh per job. Write one file per adjustment-carrying row into THIS
      // job's own temp dir (never assets/luts, which is a shared, read-only, static pack) before
      // buildComposeArgs runs, at the exact `adjustment-${rowIndex}.cube` path appendFilterChain
      // expects. Identity stacks are skipped — nothing to grade, mirrors the zero-intensity skip.
      await Promise.all(
        (spec.filters ?? []).map(async (filter, index) => {
          if (!filter.adjustments || isIdentityAdjustment(filter.adjustments)) return;
          const cubePath = path.join(tempDir, `adjustment-${index}.cube`);
          await writeFile(cubePath, buildAdjustmentCube(filter.adjustments), 'utf-8');
        }),
      );

      const args = buildComposeArgs({
        spec,
        clipPaths,
        audioPaths,
        assPath,
        textOverlayAssPath,
        fontsDir,
        lutsDir,
        adjustmentCubesDir: tempDir,
        outPath,
      });
      await runFfmpeg(args);

      const r2Key = `generations/${generationId}.mp4`;
      await uploadFileToR2(outPath, r2Key);
      return { r2Key };
    } else if (op === 'explainer_compose') {
      const spec = data.explainerCompose;
      if (!spec) throw new Error('ffmpeg explainer_compose op requires data.explainerCompose');

      const clipPaths: string[] = [];
      for (let i = 0; i < spec.clips.length; i++) {
        const clipPath = path.join(tempDir, `scene${i}.mp4`);
        await downloadR2KeyToFile(spec.clips[i].r2Key, clipPath);
        clipPaths.push(clipPath);
      }

      const narrationPath = path.join(tempDir, 'narration.wav');
      await downloadR2KeyToFile(spec.narrationR2Key, narrationPath);

      let musicPath: string | null = null;
      if (spec.musicR2Key) {
        musicPath = path.join(tempDir, 'music.wav');
        await downloadR2KeyToFile(spec.musicR2Key, musicPath);
      }

      const captionAssPath = path.join(tempDir, 'captions.ass');
      const captionAssContents = buildAssFile(
        spec.captionCues,
        spec.captionStyle,
        { width: spec.width, height: spec.height },
      );
      await writeFile(captionAssPath, captionAssContents, 'utf-8');

      const fontsDir = path.resolve('assets/fonts');
      const args = buildExplainerComposeArgs({
        spec,
        clipPaths,
        narrationPath,
        musicPath,
        captionAssPath,
        fontsDir,
        outPath,
      });
      await runFfmpeg(args);

      const r2Key = `generations/${generationId}.mp4`;
      await uploadFileToR2(outPath, r2Key);
      return { r2Key };
    } else if (op === 'summary_compose') {
      const spec = data.summaryCompose;
      if (!spec || spec.clips.length === 0) {
        throw new Error('ffmpeg summary_compose op requires clips');
      }

      const sourcePath = path.join(tempDir, 'source.mp4');
      await downloadR2KeyToFile(spec.sourceR2Key, sourcePath);
      const narrationPath = path.join(tempDir, 'narration.wav');
      await downloadR2KeyToFile(spec.narrationR2Key, narrationPath);

      let musicPath: string | null = null;
      if (spec.musicR2Key) {
        musicPath = path.join(tempDir, 'music.wav');
        await downloadR2KeyToFile(spec.musicR2Key, musicPath);
      }

      const captionAssPath = path.join(tempDir, 'captions.ass');
      await writeFile(
        captionAssPath,
        buildAssFile(spec.captionCues, spec.captionStyle, { width: spec.width, height: spec.height }),
        'utf-8',
      );
      const args = buildSummaryComposeArgs({
        spec,
        sourcePath,
        narrationPath,
        musicPath,
        captionAssPath,
        fontsDir: path.resolve('assets/fonts'),
        outPath,
      });
      await runFfmpeg(args);

      const r2Key = `generations/${generationId}.mp4`;
      await uploadFileToR2(outPath, r2Key);
      return { r2Key };
    } else {
      const clipPaths: string[] = [];
      for (let i = 0; i < inputR2Keys.length; i++) {
        const clipPath = path.join(tempDir, `clip${i}.mp4`);
        await downloadR2KeyToFile(inputR2Keys[i], clipPath);
        clipPaths.push(clipPath);
      }
      const listPath = path.join(tempDir, 'list.txt');
      // Concat-demuxer filelist — entries are always our own tempDir paths written above, never
      // raw R2 keys or user input, so single-quote escaping here is a hygiene measure, not a
      // security boundary (the boundary is that nothing outside tempDir is ever referenced).
      const listContents = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
      await writeFile(listPath, listContents, 'utf-8');
      try {
        await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
      } catch {
        // Codec/resolution mismatch across clips — fall back to a re-encode.
        await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-c:a', 'aac', outPath]);
      }
      const r2Key = `generations/${generationId}.mp4`;
      await uploadFileToR2(outPath, r2Key);
      return { r2Key };
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
