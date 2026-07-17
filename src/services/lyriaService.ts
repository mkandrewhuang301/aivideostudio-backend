import { uploadBufferToR2 } from './archivalService';
import { falRunLyria } from './providers/FalProvider';

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

/**
 * `auto` is resolved to a concrete mood by the worker before this call. The approximately
 * 30-second result is generated once, then looped and trimmed during Plan 14-05 composition.
 */
export async function generateMusicBed(
  mood: string,
  modelId: string,
  generationId: string,
): Promise<{ r2Key: string } | null> {
  if (mood === 'none') return null;

  try {
    const audioUrl = await falRunLyria(modelId, {
      prompt: `${mood} instrumental background music, documentary underscore`,
      negative_prompt: 'vocals, singing, lyrics, low quality',
    });
    if (typeof audioUrl !== 'string' || audioUrl.length === 0) {
      throw new SafeLyriaError('Lyria music failed (missing output)');
    }

    const audio = await downloadMusicBed(audioUrl);
    const r2Key = `generations/${generationId}.music.wav`;
    await uploadBufferToR2(audio, r2Key, 'audio/wav');
    return { r2Key };
  } catch (error) {
    if (error instanceof SafeLyriaError) throw error;
    throw new Error(`Lyria music failed (${statusFrom(error)})`);
  }
}
