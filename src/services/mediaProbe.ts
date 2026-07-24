// src/services/mediaProbe.ts
// Phase 13 (Edit Studio) — Plan 13-20 Task B1: probes a video's real duration at clip-import
// time so project_clips.original_duration_seconds is never left null (the root cause of the
// 0:00 total-duration / black-preview / 30px-stub-pill bug — see 13-20-EDITOR-VISUAL-PARITY-PLAN.md).
// Plan 13-22 Task B1: extended to also probe pixel width/height (needed for the "Original" canvas
// aspect ratio) — one ffprobe call covers duration + dimensions for both video AND image clips
// (ffprobe reads image dimensions too).
//
// `nixpacks.toml` provisions the full ffmpeg nix package, so `ffprobe` ships alongside the
// `ffmpeg` binary frameExtractor.ts already calls on Railway.
//
// T-09.3-03 pattern (same as frameExtractor.ts/ffmpegProcessor.ts): execFile with a FIXED argv
// array, never a shell string — `input` (a local temp path OR a presigned R2 URL) is passed as
// its own argv element, never interpolated into a command string.

import { execFile } from 'child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProbedVideoMeta {
  /** Fractional seconds, or null when unresolvable (e.g. a still image with no format duration). */
  durationSeconds: number | null;
  /** Pixel width, rotation-corrected (see below), or null on any failure. */
  width: number | null;
  /** Pixel height, rotation-corrected (see below), or null on any failure. */
  height: number | null;
}

interface FfprobeStreamSideData {
  rotation?: number;
}

interface FfprobeStream {
  width?: number;
  height?: number;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: FfprobeStreamSideData[];
}

interface FfprobeFrameStream {
  nb_read_frames?: string;
  nb_frames?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

interface FfprobeFrameJson {
  streams?: FfprobeFrameStream[];
  format?: { duration?: string };
}

interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

/**
 * Probes a media file/URL's duration + pixel dimensions in ONE ffprobe call. Never throws — any
 * failure (missing binary, unparseable output, non-zero exit) resolves to all-null fields so
 * callers can log and proceed with a partial/absent probe result; a probe failure must NEVER fail
 * a clip import.
 *
 * ⚠️ Rotation metadata: a portrait phone video's encoded stream is often stored at LANDSCAPE
 * pixel dimensions with a ±90° rotation applied at playback via either the legacy `rotate` tag or
 * the modern displaymatrix `side_data_list[].rotation` field (different encoders/containers pick
 * one or the other). When either is present and represents a ±90° turn, width/height are swapped
 * so the reported dimensions match what actually renders on screen.
 */
export async function probeVideoMeta(input: string): Promise<ProbedVideoMeta> {
  try {
    // Deliberately NOT `-show_entries ...:stream_side_data=rotation`: that section name does not
    // exist in ffprobe 4.x, which rejects the whole option and makes EVERY probe return nulls.
    // Full -show_streams output is version-stable and still carries side_data_list.rotation.
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      input,
    ]);

    const parsed = JSON.parse(stdout) as FfprobeJson;
    const stream = parsed.streams?.[0];

    let width = typeof stream?.width === 'number' ? stream.width : null;
    let height = typeof stream?.height === 'number' ? stream.height : null;

    const tagRotate = stream?.tags?.rotate != null ? parseInt(stream.tags.rotate, 10) : null;
    const sideDataRotation =
      stream?.side_data_list?.find((sd) => typeof sd.rotation === 'number')?.rotation ?? null;
    const rotation = Number.isFinite(tagRotate) ? tagRotate : sideDataRotation;

    if (width != null && height != null && rotation != null) {
      const normalized = ((rotation % 360) + 360) % 360;
      if (normalized === 90 || normalized === 270) {
        const swapped = width;
        width = height;
        height = swapped;
      }
    }

    const durationRaw = stream?.duration ?? parsed.format?.duration;
    const durationValue = durationRaw != null ? parseFloat(durationRaw) : NaN;
    const durationSeconds = Number.isFinite(durationValue) && durationValue > 0 ? durationValue : null;

    return { durationSeconds, width, height };
  } catch (err) {
    console.error('[mediaProbe] probeVideoMeta failed (returning nulls):', err);
    return { durationSeconds: null, width: null, height: null };
  }
}

/**
 * Returns the media's duration in (fractional) seconds, or `null` on any failure — probe
 * failures must NEVER throw and must never fail an import; callers log and proceed with a null
 * duration. `input` may be a local temp file path or an https URL (ffprobe supports both).
 * Delegates to probeVideoMeta — kept as its own export so existing duration-only call sites don't
 * need to change.
 */
export async function probeDurationSeconds(input: string): Promise<number | null> {
  const { durationSeconds } = await probeVideoMeta(input);
  return durationSeconds;
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numeratorRaw, denominatorRaw] = value.split('/');
  const numerator = Number(numeratorRaw);
  const denominator = denominatorRaw == null ? 1 : Number(denominatorRaw);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    return null;
  }
  return numerator / denominator;
}

/**
 * Counts a video's actual decoded frames for frame-metered provider billing. `-count_frames`
 * makes `nb_read_frames` authoritative when the container does not publish `nb_frames`; the
 * fps × duration fallback is used only when neither count is available. Unlike
 * `probeVideoMeta`, a failure is intentionally surfaced as `null` so callers can reject before
 * deducting credits instead of billing from an estimate.
 */
export async function probeVideoFrameCount(input: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-count_frames',
      '-select_streams', 'v:0',
      '-show_entries',
      'stream=nb_read_frames,nb_frames,avg_frame_rate,r_frame_rate,duration:format=duration',
      '-of', 'json',
      input,
    ]);

    const parsed = JSON.parse(stdout) as FfprobeFrameJson;
    const stream = parsed.streams?.[0];
    const countedFrames = parsePositiveNumber(stream?.nb_read_frames)
      ?? parsePositiveNumber(stream?.nb_frames);
    if (countedFrames != null && Number.isInteger(countedFrames)) return countedFrames;

    const frameRate = parseFrameRate(stream?.avg_frame_rate)
      ?? parseFrameRate(stream?.r_frame_rate);
    const duration = parsePositiveNumber(stream?.duration)
      ?? parsePositiveNumber(parsed.format?.duration);
    if (frameRate == null || duration == null) return null;

    return Math.ceil(frameRate * duration - 1e-3);
  } catch (err) {
    console.error('[mediaProbe] probeVideoFrameCount failed (returning null):', err);
    return null;
  }
}
