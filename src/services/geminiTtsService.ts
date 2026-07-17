import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { uploadBufferToR2 } from './archivalService';
import { probeDurationSeconds } from './mediaProbe';
import { falRunTts } from './providers/FalProvider';

const TTS_DOWNLOAD_TIMEOUT_MS = 60_000;

export interface NarrationStem {
  r2Key: string;
  durationSeconds: number;
}

class SafeTtsError extends Error {}

function statusFrom(error: unknown): string {
  if (!error || typeof error !== 'object' || !('status' in error)) return 'unknown';
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' || typeof status === 'string' ? String(status) : 'unknown';
}

async function downloadTtsWav(audioUrl: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(audioUrl, { signal: controller.signal });
    if (!response.ok) throw new SafeTtsError(`Gemini TTS download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export async function generateNarrationForScene(
  text: string,
  voiceName: string,
  modelId: string,
  generationId: string,
  sceneIndex: number,
): Promise<NarrationStem> {
  let tempDir: string | undefined;
  try {
    const audioUrl = await falRunTts(modelId, {
      prompt: text,
      voice: voiceName,
      output_format: 'wav',
    });
    if (typeof audioUrl !== 'string' || audioUrl.length === 0) {
      throw new SafeTtsError('Gemini TTS failed (missing output)');
    }

    const audio = await downloadTtsWav(audioUrl);
    tempDir = await mkdtemp(path.join(tmpdir(), 'explainer-tts-'));
    const tempPath = path.join(tempDir, `scene-${sceneIndex}.wav`);
    await writeFile(tempPath, audio);

    const durationSeconds = await probeDurationSeconds(tempPath);
    if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new SafeTtsError('Gemini TTS duration could not be measured');
    }

    const r2Key = `generations/${generationId}.narration.${sceneIndex}.wav`;
    await uploadBufferToR2(audio, r2Key, 'audio/wav');
    return { r2Key, durationSeconds };
  } catch (error) {
    if (error instanceof SafeTtsError) throw error;
    throw new Error(`Gemini TTS failed (${statusFrom(error)})`);
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}
