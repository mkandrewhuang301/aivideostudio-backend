// Manual live-provider spike for the post-Phase-14 fal Tools queue.
//
// Real spend: approximately $0.15 with the two-second sample generated below.
// Run from the backend repository with:
//   npx tsx scripts/spike-fal-tools.ts
//
// This is intentionally excluded from CI. It verifies provider response shapes and media
// properties before production code is written. @fal-ai/client reads FAL_KEY from .env.

import 'dotenv/config';

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ApiError, fal } from '@fal-ai/client';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

const IMAGE_MODEL = 'pixelcut/background-removal';
const VIDEO_MODEL = 'pixelcut/video-background-removal';
const TRANSLATE_MODEL = 'fal-ai/heygen/v2/translate/speed';
const SOURCE_VIDEO_URL =
  'https://v3b.fal.media/files/b/0a9004c7/FM7Q5tK2b59x66Bl8HC0Z_vt-lang-en.mp4';
const REPORT_PATH = path.join(tmpdir(), 'fal-tools-wave0-report.json');

type JsonRecord = Record<string, unknown>;

interface ProviderFile {
  url: string;
  content_type?: string;
  file_name?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

interface SpikeReport {
  started_at: string;
  completed_at?: string;
  source: JsonRecord;
  stages: Record<string, JsonRecord>;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as JsonRecord;
}

function providerFile(data: unknown, field: 'image' | 'video'): ProviderFile {
  const root = asRecord(data, 'provider response');
  const file = asRecord(root[field], `provider response.${field}`);
  if (typeof file.url !== 'string' || file.url.length === 0) {
    throw new Error(`provider response.${field}.url was missing`);
  }
  return file as unknown as ProviderFile;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function probe(filePath: string): Promise<JsonRecord> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    filePath,
  ]);
  return asRecord(JSON.parse(stdout) as unknown, 'ffprobe output');
}

async function runStage(
  report: SpikeReport,
  name: string,
  action: () => Promise<JsonRecord>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const metadata = await action();
    report.stages[name] = {
      status: 'PASS',
      latency_seconds: Number(((Date.now() - startedAt) / 1_000).toFixed(2)),
      ...metadata,
    };
    console.log(`PASS ${name}`, JSON.stringify(report.stages[name], null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const providerDetails = error instanceof ApiError
      ? { provider_status: error.status, provider_body: error.body }
      : {};
    report.stages[name] = {
      status: 'FAIL',
      latency_seconds: Number(((Date.now() - startedAt) / 1_000).toFixed(2)),
      error: message,
      ...providerDetails,
    };
    console.error(`FAIL ${name}: ${message}`);
  }
}

async function main(): Promise<void> {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY is missing');

  const report: SpikeReport = {
    started_at: new Date().toISOString(),
    source: {
      official_sample_url: SOURCE_VIDEO_URL,
      trimmed_duration_seconds: 2,
      output_language: 'Spanish',
    },
    stages: {},
  };
  const tempDir = await mkdtemp(path.join(tmpdir(), 'fal-tools-wave0-'));
  const videoOnly = process.argv.includes('--video-only');
  const videoOutputFormat = process.argv.includes('--prores') ? 'mov_proresks' : 'mov_h265';
  report.source.video_output_format = videoOutputFormat;

  try {
    const sourcePath = path.join(tempDir, 'source.mp4');
    const clipPath = path.join(tempDir, 'input.mp4');
    const framePath = path.join(tempDir, 'input.jpg');

    await writeFile(sourcePath, await download(SOURCE_VIDEO_URL));
    await execFileAsync('ffmpeg', [
      '-v', 'error', '-y',
      '-i', sourcePath,
      '-t', '2',
      '-vf', 'scale=640:-2',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '96k',
      clipPath,
    ]);
    await execFileAsync('ffmpeg', [
      '-v', 'error', '-y',
      '-ss', '0.5',
      '-i', clipPath,
      '-frames:v', '1',
      framePath,
    ]);

    const clipBytes = await readFile(clipPath);
    const frameBytes = await readFile(framePath);
    const clipUrl = await fal.storage.upload(new Blob([clipBytes], { type: 'video/mp4' }), {
      lifecycle: { expiresIn: '1d' },
    });
    const frameUrl = await fal.storage.upload(new Blob([frameBytes], { type: 'image/jpeg' }), {
      lifecycle: { expiresIn: '1d' },
    });
    report.source.input_ffprobe = await probe(clipPath);

    if (!videoOnly) await runStage(report, 'image_background_removal', async () => {
      const result = await fal.subscribe(IMAGE_MODEL, {
        input: {
          image_url: frameUrl,
          output_format: 'rgba',
          sync_mode: false,
        },
      });
      const data = asRecord(result.data, 'image removal response');
      const image = providerFile(data, 'image');
      const outputBytes = await download(image.url);
      const metadata = await sharp(outputBytes).metadata();
      return {
        request_id_present: typeof result.requestId === 'string' && result.requestId.length > 0,
        output_keys: Object.keys(data),
        image_keys: Object.keys(image),
        content_type: image.content_type ?? null,
        file_name: image.file_name ?? null,
        file_size: image.file_size ?? outputBytes.length,
        width: image.width ?? metadata.width ?? null,
        height: image.height ?? metadata.height ?? null,
        format: metadata.format ?? null,
        channels: metadata.channels ?? null,
        has_alpha: metadata.hasAlpha ?? false,
      };
    });

    await runStage(report, 'video_background_removal', async () => {
      const result = await fal.subscribe(VIDEO_MODEL, {
        input: {
          video_url: clipUrl,
          background: 'transparent',
          output_format: videoOutputFormat,
        },
      });
      const data = asRecord(result.data, 'video removal response');
      const video = providerFile(data, 'video');
      const outputBytes = await download(video.url);
      const outputPath = path.join(tempDir, 'transparent.mov');
      await writeFile(outputPath, outputBytes);
      return {
        request_id_present: typeof result.requestId === 'string' && result.requestId.length > 0,
        output_keys: Object.keys(data),
        video_keys: Object.keys(video),
        content_type: video.content_type ?? null,
        file_name: video.file_name ?? null,
        file_size: video.file_size ?? outputBytes.length,
        ffprobe: await probe(outputPath),
      };
    });

    if (!videoOnly) await runStage(report, 'heygen_translate_speed', async () => {
      const result = await fal.subscribe(TRANSLATE_MODEL, {
        input: {
          video_url: clipUrl,
          output_language: 'Spanish',
          translate_audio_only: false,
          enable_dynamic_duration: true,
        },
      });
      const data = asRecord(result.data, 'translate response');
      const video = providerFile(data, 'video');
      const outputBytes = await download(video.url);
      const outputPath = path.join(tempDir, 'translated.mp4');
      await writeFile(outputPath, outputBytes);
      return {
        request_id_present: typeof result.requestId === 'string' && result.requestId.length > 0,
        output_keys: Object.keys(data),
        video_keys: Object.keys(video),
        content_type: video.content_type ?? null,
        file_name: video.file_name ?? null,
        file_size: video.file_size ?? outputBytes.length,
        ffprobe: await probe(outputPath),
      };
    });
  } finally {
    report.completed_at = new Date().toISOString();
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    await rm(tempDir, { recursive: true, force: true });
  }

  const failed = Object.values(report.stages).filter((stage) => stage.status !== 'PASS');
  console.log(`Wave-0 report written to ${REPORT_PATH}`);
  if (failed.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Wave-0 spike failed: ${message}`);
  process.exitCode = 1;
});
