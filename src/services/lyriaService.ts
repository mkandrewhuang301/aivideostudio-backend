import { config } from '../config';
import { uploadBufferToR2 } from './archivalService';
import { falRunLyria } from './providers/FalProvider';
import { googleRunLyria } from './providers/GoogleAudioProvider';

const LYRIA_DOWNLOAD_TIMEOUT_MS = 120_000;

class SafeLyriaError extends Error {}

function statusFrom(error: unknown): string {
  if (!error || typeof error !== 'object' || !('status' in error)) return 'unknown';
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' || typeof status === 'string' ? String(status) : 'unknown';
}

async function downloadMusicBed(audioUrl: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LYRIA_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(audioUrl, { signal: controller.signal });
    if (!response.ok) throw new SafeLyriaError(`Lyria music download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function isNativeGoogleLyriaModel(modelId: string): boolean {
  return modelId.startsWith('lyria-');
}

async function generateFalMusic(modelId: string, prompt: string): Promise<{
  audio: Buffer;
  extension: 'wav';
  contentType: 'audio/wav';
}> {
  const audioUrl = await falRunLyria(modelId, {
    prompt,
    negative_prompt: 'vocals, singing, lyrics, low quality',
  });
  if (typeof audioUrl !== 'string' || audioUrl.length === 0) {
    throw new SafeLyriaError('Lyria music failed (missing output)');
  }
  return {
    audio: await downloadMusicBed(audioUrl),
    extension: 'wav',
    contentType: 'audio/wav',
  };
}

async function generateMusic(modelId: string, prompt: string): Promise<{
  audio: Buffer;
  extension: 'mp3' | 'wav';
  contentType: 'audio/mpeg' | 'audio/wav';
}> {
  if (!isNativeGoogleLyriaModel(modelId)) return generateFalMusic(modelId, prompt);

  if (config.googleNativeAudioEnabled) {
    try {
      const result = await googleRunLyria(modelId, prompt);
      if (!result.mimeType.startsWith('audio/mpeg') && !result.mimeType.startsWith('audio/mp3')) {
        throw new SafeLyriaError('Lyria music failed (unsupported native audio format)');
      }
      return { audio: result.audio, extension: 'mp3', contentType: 'audio/mpeg' };
    } catch (error) {
      if (!config.googleAudioFalFallbackEnabled) throw error;
      console.warn('Native Google Lyria failed; using configured Fal fallback');
    }
  }

  return generateFalMusic(config.falLyriaFallbackModel, prompt);
}

/**
 * `auto` is resolved to a concrete mood by the worker before this call. The approximately
 * 30-second result is generated once, then looped and trimmed during Plan 14-05 composition.
 */
export async function generateMusicBed(
  mood: string,
  modelId: string,
  generationId: string,
  direction?: string,
): Promise<{ r2Key: string } | null> {
  if (mood === 'none') return null;

  try {
    const prompt = [
      `${mood} instrumental background music, documentary underscore. Instrumental only, no vocals.`,
      direction?.trim(),
    ].filter(Boolean).join(' ');
    const result = await generateMusic(modelId, prompt);
    const r2Key = `generations/${generationId}.music.${result.extension}`;
    await uploadBufferToR2(result.audio, r2Key, result.contentType);
    return { r2Key };
  } catch (error) {
    if (error instanceof SafeLyriaError) throw error;
    throw new Error(`Lyria music failed (${statusFrom(error)})`);
  }
}
