// src/services/mediaProbe.ts
// Phase 13 (Edit Studio) — Plan 13-20 Task B1: probes a video's real duration at clip-import
// time so project_clips.original_duration_seconds is never left null (the root cause of the
// 0:00 total-duration / black-preview / 30px-stub-pill bug — see 13-20-EDITOR-VISUAL-PARITY-PLAN.md).
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

/**
 * Returns the media's duration in (fractional) seconds, or `null` on any failure — probe
 * failures must NEVER throw and must never fail an import; callers log and proceed with a null
 * duration. `input` may be a local temp file path or an https URL (ffprobe supports both).
 */
export async function probeDurationSeconds(input: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      input,
    ]);
    const value = parseFloat(stdout.trim());
    if (!Number.isFinite(value) || value <= 0) return null;
    return value;
  } catch (err) {
    console.error('[mediaProbe] probeDurationSeconds failed (returning null):', err);
    return null;
  }
}
