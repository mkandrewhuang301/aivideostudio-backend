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
import type { FfmpegJobData, ComposeSpec } from './ffmpegWorker';

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
  outPath: string;
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
  const { spec, clipPaths, audioPaths, assPath, textOverlayAssPath, fontsDir, outPath } = input;
  const { width, height } = resolveComposeCanvas(spec);

  const args: string[] = ['-y'];
  const filterParts: string[] = [];

  // Per-clip video/audio input args + normalize (trim/scale/pad) filter chains.
  spec.clips.forEach((clip, i) => {
    const clipPath = clipPaths[i];
    const duration = Math.max(0, clip.trimEndSeconds - clip.trimStartSeconds);
    if (clip.mediaType === 'image') {
      // No native duration/audio track on a still image — loop it for the clip's trim duration
      // and synthesize a silent audio stream so concat's a=1 (uniform audio-stream-per-input
      // requirement) stays satisfied alongside the real video clips.
      args.push('-loop', '1', '-t', String(duration), '-i', clipPath);
      filterParts.push(
        `[${i}:v]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`,
      );
      filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100:duration=${duration}[a${i}]`);
    } else {
      args.push('-i', clipPath);
      filterParts.push(
        `[${i}:v]trim=start=${clip.trimStartSeconds}:end=${clip.trimEndSeconds},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`,
      );
      filterParts.push(
        `[${i}:a]atrim=start=${clip.trimStartSeconds}:end=${clip.trimEndSeconds},asetpts=PTS-STARTPTS[a${i}]`,
      );
    }
  });

  // Independent audio clip inputs — indexed AFTER every clip input.
  const audioInputBase = spec.clips.length;
  spec.audioClips.forEach((audioClip, j) => {
    args.push('-i', audioPaths[j]);
    const inputIndex = audioInputBase + j;
    const delayMs = Math.max(0, Math.round(audioClip.startOffsetSeconds * 1000));
    filterParts.push(
      `[${inputIndex}:a]atrim=start=${audioClip.trimStartSeconds}:end=${audioClip.trimEndSeconds},asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1[aud${j}]`,
    );
  });

  // Concat every clip's normalized video+audio pair into one base stream.
  const concatInputs = spec.clips.map((_, i) => `[v${i}][a${i}]`).join('');
  filterParts.push(`${concatInputs}concat=n=${spec.clips.length}:v=1:a=1[vconcat][aconcat]`);

  // Burn Text overlays via the generated ASS file (G4's buildTextOverlayAss) — native rotation
  // (\frz) + scale (\fs), unlike the old drawtext loop this replaces.
  let videoLabel = 'vconcat';
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
  let audioLabel = 'aconcat';
  if (spec.audioClips.length > 0) {
    const amixInputs = ['[aconcat]', ...spec.audioClips.map((_, j) => `[aud${j}]`)].join('');
    filterParts.push(
      `${amixInputs}amix=inputs=${spec.audioClips.length + 1}:duration=first:dropout_transition=0[amixed]`,
    );
    audioLabel = 'amixed';
  }

  // The ENTIRE filter graph is one argv element — never interpolated into a shell command (T-13-11).
  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', `[${videoLabel}]`, '-map', `[${audioLabel}]`);
  args.push('-c:v', 'libx264', '-c:a', 'aac', outPath);

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
      const args = buildComposeArgs({ spec, clipPaths, audioPaths, assPath, textOverlayAssPath, fontsDir, outPath });
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
