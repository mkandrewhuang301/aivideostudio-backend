import { Job, Queue, Worker } from 'bullmq';
import { config } from '../config';
import { uploadBufferToR2 } from '../services/archivalService';
import { LyriaMusicProvider, MusicProviderError } from '../services/providers/LyriaMusicProvider';
import type { MusicGenerationResult } from '../services/providers/MusicGenerationProvider';
import {
  completeSoundtrack,
  getSoundtrackGenerationRow,
  markSoundtrackProcessing,
  refundSoundtrack,
  saveSoundtrackRaw,
  type SoundtrackProjectSnapshot,
} from '../services/soundtrackService';
import {
  processSoundtrackAudio,
  readSoundtrackRaw,
  soundtrackReferenceImages,
} from '../services/soundtrackMediaService';

const QUEUE_NAME = 'ai-soundtrack-generation';
const connection = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export interface SoundtrackGenerationJob {
  soundtrackId: string;
}

export const soundtrackGenerationQueue = new Queue<SoundtrackGenerationJob>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

function timestamp(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

export function soundtrackPrompt(row: {
  project_snapshot: unknown;
  sound_mode: string;
  direction: string | null;
}): string {
  const snapshot = row.project_snapshot as SoundtrackProjectSnapshot;
  const timeline = snapshot.clips.map((clip, index) =>
    `[${timestamp(clip.timeline_start)} - ${timestamp(clip.timeline_end)}] Scene ${index + 1}: match the visual energy and transition cleanly.`,
  ).join('\n');
  const vocalInstruction = row.sound_mode === 'vocals'
    ? 'Create an original featured song with original lyrics and vocals that fit the visual story. Do not quote or imitate any existing song, lyrics, singer, or named artist.'
    : 'Instrumental only. No singing, spoken words, humming, or lyrics. Keep the mix supportive under possible narration.';
  return [
    `Create one original soundtrack for a ${snapshot.duration_seconds.toFixed(2)} second video titled "${snapshot.title}".`,
    row.direction ? `Creative direction: ${row.direction}` : 'Infer the mood, genre, pacing, and instrumentation from the attached scene images.',
    vocalInstruction,
    'Follow the scene timing below, build with the edit, avoid abrupt starts, and compose a clean ending at the exact final timestamp.',
    timeline,
  ].join('\n');
}

const provider = new LyriaMusicProvider();

export async function processSoundtrackGeneration(job: Job<SoundtrackGenerationJob>): Promise<void> {
  const id = job.data.soundtrackId;
  let row = await markSoundtrackProcessing(id);
  if (!row) row = await getSoundtrackGenerationRow(id);
  if (!row || row.status === 'completed' || row.status === 'refunded') return;

  let rawAudio: Buffer;
  let rawKey = row.raw_r2_key;
  let providerRequestId = row.provider_request_id ?? undefined;
  if (rawKey) {
    rawAudio = await readSoundtrackRaw(rawKey);
  } else {
    const snapshot = row.project_snapshot as SoundtrackProjectSnapshot;
    const references = await soundtrackReferenceImages(snapshot);
    let generated: MusicGenerationResult;
    try {
      generated = await provider.generate({
        model: row.model,
        prompt: soundtrackPrompt(row),
        referenceImages: references,
      });
    } catch (error) {
      if (error instanceof MusicProviderError && !error.retryable) job.discard();
      throw error;
    }
    rawAudio = generated.audio;
    providerRequestId = generated.providerRequestId;
    rawKey = `ai-soundtracks/raw/${row.user_id}/${row.id}.mp3`;
    await uploadBufferToR2(rawAudio, rawKey, generated.mimeType);
    await saveSoundtrackRaw(row.id, rawKey, providerRequestId);
  }

  const finalAudio = await processSoundtrackAudio(row.id, rawAudio, row.project_duration_seconds);
  const finalKey = `ai-soundtracks/final/${row.user_id}/${row.id}.m4a`;
  await uploadBufferToR2(finalAudio, finalKey, 'audio/mp4');
  await completeSoundtrack({
    id: row.id,
    rawR2Key: rawKey,
    finalR2Key: finalKey,
    providerRequestId,
    displayName: row.sound_mode === 'vocals' ? 'Original Video Song' : 'Tailored Soundtrack',
  });
}

export const soundtrackGenerationWorker = new Worker<SoundtrackGenerationJob>(
  QUEUE_NAME,
  processSoundtrackGeneration,
  {
    connection,
    concurrency: Math.max(1, config.aiMusicWorkerConcurrency),
    limiter: { max: Math.max(1, config.aiMusicRequestsPerMinute), duration: 60_000 },
  },
);

soundtrackGenerationWorker.on('failed', async (job, error) => {
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  const providerError = error instanceof MusicProviderError ? error : undefined;
  await refundSoundtrack(
    job.data.soundtrackId,
    providerError?.code ?? 'generation_failed',
    providerError?.retryable ? 'Music generation failed after retries' : 'Music generation was rejected',
  ).catch((refundError) => console.error('[ai-music] refund failed', refundError));
});
