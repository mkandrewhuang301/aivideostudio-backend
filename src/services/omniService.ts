import { uploadBufferToR2 } from './archivalService';
import { falRunOmniI2v } from './providers/FalProvider';

const OMNI_DOWNLOAD_TIMEOUT_MS = 300_000;

class SafeOmniError extends Error {}

function statusFrom(error: unknown): string {
  if (!error || typeof error !== 'object' || !('status' in error)) return 'unknown';
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' || typeof status === 'string' ? String(status) : 'unknown';
}

async function downloadOmniClip(videoUrl: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OMNI_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(videoUrl, { signal: controller.signal });
    if (!response.ok) throw new SafeOmniError(`Omni clip download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * D-08: animate the vision-picked winning still for approximately the narration duration.
 * Omni accepts integer 3-10s only; Plan 14-05 trims the clip to the exact narration length.
 */
export async function animateScene(
  stillUrl: string,
  motionPrompt: string,
  modelId: string,
  aspectRatio: '9:16' | '16:9',
  narrationDurationSeconds: number,
  generationId: string,
  sceneIndex: number,
): Promise<{ r2Key: string }> {
  try {
    const duration = Math.min(10, Math.max(3, Math.ceil(narrationDurationSeconds)));
    const videoUrl = await falRunOmniI2v(modelId, {
      prompt: motionPrompt,
      image_url: stillUrl,
      aspect_ratio: aspectRatio,
      duration,
    });
    if (typeof videoUrl !== 'string' || videoUrl.length === 0) {
      throw new SafeOmniError('Omni animation failed (missing output)');
    }

    const video = await downloadOmniClip(videoUrl);
    const r2Key = `generations/${generationId}.scene${sceneIndex}.mp4`;
    await uploadBufferToR2(video, r2Key, 'video/mp4');
    return { r2Key };
  } catch (error) {
    if (error instanceof SafeOmniError) throw error;
    throw new Error(`Omni animation failed (${statusFrom(error)})`);
  }
}
