// Manual smoke, real spend ~$1.50, run with:
//   npx tsx scripts/smoke-explainer-pipeline.ts
// After a partial provider failure, retry WhisperX without repeating fal spend with:
//   WHISPERX_AUDIO_URL=<existing-gemini-tts-url> npx tsx scripts/smoke-explainer-pipeline.ts --whisperx-only
//
// This is intentionally not part of CI. Run it only when live provider schemas need to be
// verified. Authentication mirrors production: @fal-ai/client reads FAL_KEY from the environment,
// while Replicate receives config.replicateApiToken exactly as ReplicateProvider.ts does.

import 'dotenv/config';

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fal } from '@fal-ai/client';
import Replicate from 'replicate';
import { config } from '../src/config';

const execFileAsync = promisify(execFile);

const TTS_MODEL = 'fal-ai/gemini-3.1-flash-tts' as const;
const LYRIA_MODEL = 'fal-ai/lyria2' as const;
const OMNI_MODEL = 'google/gemini-omni-flash/image-to-video' as const;
const WHISPERX_VERSION = '655845d6190ef70573c669245f245892cd039df4b880a1e3a65852c09252f5cc';
const WHISPERX_MODEL = `victor-upmeet/whisperx:${WHISPERX_VERSION}` as const;
const SAMPLE_IMAGE_URL = 'https://storage.googleapis.com/falserverless/example_inputs/dog.png';
const REPORT_PATH = path.join(tmpdir(), 'phase14-explainer-smoke-report.json');

type JsonRecord = Record<string, unknown>;

interface ProviderFile {
  url: string;
  content_type?: string;
  file_name?: string;
  file_size?: number;
}

interface SmokeReport {
  started_at: string;
  completed_at?: string;
  stages: Record<string, JsonRecord>;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as JsonRecord;
}

function providerFile(data: unknown, field: 'audio' | 'video'): ProviderFile {
  const root = asRecord(data, 'provider response');
  const file = asRecord(root[field], `provider response.${field}`);
  if (typeof file.url !== 'string' || !file.url) {
    throw new Error(`provider response.${field}.url was missing`);
  }
  return file as unknown as ProviderFile;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function firstBytes(buffer: Buffer, count = 4): string {
  return buffer.subarray(0, count).toString('ascii');
}

function findWordObjects(value: unknown, depth = 0): JsonRecord[] {
  if (depth > 5) return [];
  if (Array.isArray(value)) {
    const directWords = value.filter((item): item is JsonRecord => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const candidate = item as JsonRecord;
      return typeof candidate.start === 'number'
        && typeof candidate.end === 'number'
        && typeof candidate.word === 'string';
    });
    if (directWords.length > 0) return directWords;
    for (const item of value) {
      const nested = findWordObjects(item, depth + 1);
      if (nested.length > 0) return nested;
    }
    return [];
  }
  if (!value || typeof value !== 'object') return [];
  for (const nestedValue of Object.values(value as JsonRecord)) {
    const nested = findWordObjects(nestedValue, depth + 1);
    if (nested.length > 0) return nested;
  }
  return [];
}

async function runStage(
  report: SmokeReport,
  name: string,
  action: () => Promise<JsonRecord>,
): Promise<void> {
  try {
    const metadata = await action();
    report.stages[name] = { status: 'PASS', ...metadata };
    console.log(`PASS ${name}`, JSON.stringify(metadata, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.stages[name] = { status: 'FAIL', error: message };
    console.error(`FAIL ${name}: ${message}`);
  }
}

async function main(): Promise<void> {
  const report: SmokeReport = { started_at: new Date().toISOString(), stages: {} };
  const tempDir = await mkdtemp(path.join(tmpdir(), 'explainer-smoke-'));
  const replicate = new Replicate({ auth: config.replicateApiToken });
  const whisperXOnly = process.argv.includes('--whisperx-only');
  let ttsAudioUrl = process.env.WHISPERX_AUDIO_URL;

  try {
    if (!whisperXOnly) await runStage(report, 'gemini_tts', async () => {
      const result = await fal.subscribe(TTS_MODEL, {
        input: {
          prompt: 'The quick brown fox jumps over the lazy dog.',
          voice: 'Kore',
          output_format: 'wav',
        },
      });
      const data = asRecord(result.data, 'Gemini TTS response');
      const audio = providerFile(data, 'audio');
      const bytes = await download(audio.url);
      ttsAudioUrl = audio.url;
      return {
        output_keys: Object.keys(data),
        audio_keys: Object.keys(audio),
        content_type: audio.content_type ?? null,
        first_four_bytes: firstBytes(bytes),
        byte_length: bytes.length,
      };
    });

    if (!whisperXOnly) await runStage(report, 'lyria2', async () => {
      const result = await fal.subscribe(LYRIA_MODEL, {
        input: {
          prompt: 'calm ambient instrumental, documentary underscore',
          negative_prompt: 'vocals, singing, lyrics, low quality',
        },
      });
      const data = asRecord(result.data, 'Lyria2 response');
      const audio = providerFile(data, 'audio');
      const bytes = await download(audio.url);
      const outputPath = path.join(tempDir, 'lyria.wav');
      await writeFile(outputPath, bytes);
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels',
        '-of', 'json',
        outputPath,
      ]);
      return {
        output_keys: Object.keys(data),
        audio_keys: Object.keys(audio),
        content_type: audio.content_type ?? null,
        first_four_bytes: firstBytes(bytes),
        byte_length: bytes.length,
        ffprobe: JSON.parse(stdout) as unknown,
      };
    });

    if (!whisperXOnly) await runStage(report, 'omni_i2v', async () => {
      const startedAt = Date.now();
      const result = await fal.subscribe(OMNI_MODEL, {
        input: {
          prompt: 'gentle camera push-in, subtle ambient motion',
          image_url: SAMPLE_IMAGE_URL,
          aspect_ratio: '9:16',
          duration: 4,
        },
      });
      const latencySeconds = (Date.now() - startedAt) / 1_000;
      const data = asRecord(result.data, 'Omni response');
      const video = providerFile(data, 'video');
      const bytes = await download(video.url);
      const outputPath = path.join(tempDir, 'omni.mp4');
      await writeFile(outputPath, bytes);
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=index,codec_type,codec_name,duration',
        '-of', 'json',
        outputPath,
      ]);
      const probe = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
      return {
        output_keys: Object.keys(data),
        video_keys: Object.keys(video),
        content_type: video.content_type ?? null,
        file_name: video.file_name ?? null,
        file_size: video.file_size ?? bytes.length,
        downloaded_byte_length: bytes.length,
        latency_seconds: latencySeconds,
        has_audio_stream: probe.streams?.some((stream) => stream.codec_type === 'audio') ?? false,
        ffprobe: probe as unknown,
      };
    });

    await runStage(report, 'whisperx', async () => {
      if (!ttsAudioUrl) throw new Error('Gemini TTS did not produce an audio URL');
      const output = await replicate.run(WHISPERX_MODEL, {
        input: {
          audio_file: ttsAudioUrl,
          align_output: true,
          language: 'en',
        },
      });
      const data = asRecord(output, 'WhisperX response');
      const words = findWordObjects(data);
      if (words.length === 0) throw new Error('WhisperX returned no aligned word objects');
      return {
        output_keys: Object.keys(data),
        segments_container: Array.isArray(data.segments) ? 'array' : typeof data.segments,
        first_two_words: words.slice(0, 2),
      };
    });
  } finally {
    report.completed_at = new Date().toISOString();
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    await rm(tempDir, { recursive: true, force: true });
  }

  const failures = Object.values(report.stages).filter((stage) => stage.status !== 'PASS');
  console.log(`Smoke report written to ${REPORT_PATH}`);
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Smoke harness failed: ${message}`);
  process.exitCode = 1;
});
