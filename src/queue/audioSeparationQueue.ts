// src/queue/audioSeparationQueue.ts
// Audio Separation queue + worker. Dispatches fal SAM Audio, archives BOTH stems to R2 as the
// FIRST post-result action (CLAUDE.md rule #2 — provider URLs expire, never store/serve one),
// persists the stems as project_audio_clips rows via attachSeparationStems, and refunds exactly
// once on failure via a Redis NX guard (CLAUDE.md rule #5 idiom). Closest analog:
// soundtrackGenerationQueue.ts (full Queue+Worker+on('failed') skeleton copied).

import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Job, Queue, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { projectAudioClips, projectClips } from '../db/schema';
import { getGenerationPresignedUrl, getUploadPresignedUrl, uploadBufferToR2 } from '../services/archivalService';
import {
  attachSeparationStems,
  completeAudioSeparation,
  getAudioSeparationJob,
  markAudioSeparationProcessing,
  refundAudioSeparation,
  resolveSourceClipTimelineOffset,
} from '../services/audioSeparationService';
import {
  AudioSeparationProviderError,
  falSamAudioProvider,
} from '../services/providers/FalSamAudioProvider';
import type { AudioSeparationResult } from '../services/providers/AudioSeparationProvider';
import { redis } from '../redis/client';

const execFileAsync = promisify(execFile);

const QUEUE_NAME = 'audio-separation';
const connection = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export interface AudioSeparationJobPayload {
  jobId: string;
}

export const audioSeparationQueue = new Queue<AudioSeparationJobPayload>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

/**
 * Downloads the source clip, extracts ONLY the trimmed visible window as mp3, uploads that
 * slice under a job-scoped R2 key, and returns a short-lived presigned URL for fal. Sending the
 * full untrimmed file made stems the wrong length / content for trimmed clips and made a
 * second-clip separation look empty/wrong when fal processed more than the billed window.
 */
async function prepareTrimmedSeparationInput(input: {
  jobId: string;
  r2Key: string;
  trimStartSeconds: number;
  durationSeconds: number;
}): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'audio-sep-'));
  try {
    const ext = path.extname(input.r2Key) || '.mp4';
    const sourcePath = path.join(tempDir, `source${ext}`);
    const audioPath = path.join(tempDir, 'input.mp3');

    const sourceUrl = await getGenerationPresignedUrl(input.r2Key);
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new AudioSeparationProviderError(
        `Failed to download source clip (${response.status})`,
        true,
        'fetch_failed',
      );
    }
    await writeFile(sourcePath, Buffer.from(await response.arrayBuffer()));

    await execFileAsync('ffmpeg', [
      '-y',
      '-ss', String(Math.max(0, input.trimStartSeconds)),
      '-t', String(Math.max(0.05, input.durationSeconds)),
      '-i', sourcePath,
      '-vn',
      '-c:a', 'libmp3lame',
      '-q:a', '4',
      audioPath,
    ]);

    const inputKey = `audio-separation/${input.jobId}/source-input.mp3`;
    await uploadBufferToR2(await readFile(audioPath), inputKey, 'audio/mpeg');
    // 1h upload TTL is enough for fal to fetch; generation TTL is overkill for this ephemeral key.
    return getUploadPresignedUrl(inputKey);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Resolves a job's source (clip or stem) to the r2 key + trim window + timeline position the
 * worker needs. Returns null when the source row no longer exists, which the caller turns into a
 * non-retryable 'source_missing' failure.
 */
async function resolveWorkerSource(row: { project_id: string; source_clip_id: string | null; source_audio_clip_id: string | null }): Promise<
  { r2Key: string; trimStartSeconds: number; startOffsetSeconds: number; depth: number; rootClipId: string | null } | null
> {
  if (row.source_audio_clip_id) {
    const [stem] = await db
      .select({
        r2_key: projectAudioClips.r2_key,
        trim_start_seconds: projectAudioClips.trim_start_seconds,
        start_offset_seconds: projectAudioClips.start_offset_seconds,
        separation_depth: projectAudioClips.separation_depth,
        source_clip_id: projectAudioClips.source_clip_id,
      })
      .from(projectAudioClips)
      .where(eq(projectAudioClips.id, row.source_audio_clip_id));
    if (!stem) return null;
    return {
      r2Key: stem.r2_key,
      trimStartSeconds: stem.trim_start_seconds ?? 0,
      // A stem already carries its own timeline position — no need to sum earlier clips.
      startOffsetSeconds: stem.start_offset_seconds ?? 0,
      depth: stem.separation_depth ?? 0,
      rootClipId: stem.source_clip_id,
    };
  }

  if (!row.source_clip_id) return null;
  const [clip] = await db
    .select({ r2_key: projectClips.r2_key, trim_start_seconds: projectClips.trim_start_seconds })
    .from(projectClips)
    .where(eq(projectClips.id, row.source_clip_id));
  if (!clip) return null;
  return {
    r2Key: clip.r2_key,
    trimStartSeconds: clip.trim_start_seconds ?? 0,
    startOffsetSeconds: await resolveSourceClipTimelineOffset(row.project_id, row.source_clip_id),
    depth: 0,
    rootClipId: row.source_clip_id,
  };
}

export async function processAudioSeparation(job: Job<AudioSeparationJobPayload>): Promise<void> {
  const id = job.data.jobId;
  // Idempotent re-run guard: markAudioSeparationProcessing returns null on a race (already
  // processing/terminal) — re-fetch and short-circuit on a terminal status, matching
  // soundtrackGenerationQueue.ts's exact shape.
  let row = await markAudioSeparationProcessing(id);
  if (!row) row = await getAudioSeparationJob(id);
  if (!row || row.status === 'completed' || row.status === 'refunded') return;

  // The source is a clip (depth 1) or another stem (chaining). Both resolve to an r2 key plus a
  // trim window; the ffmpeg step below already strips video to mp3, so a stem source (already
  // mp3) needs no special handling there.
  const source = await resolveWorkerSource(row);
  if (!source) {
    // Source is gone (hard-purged past the soft-delete window) — nothing to separate;
    // non-retryable, so stop burning attempts and let on('failed') refund.
    job.discard();
    throw new AudioSeparationProviderError('Separation source no longer exists', false, 'source_missing');
  }

  let audioUrl: string;
  try {
    audioUrl = await prepareTrimmedSeparationInput({
      jobId: id,
      r2Key: source.r2Key,
      trimStartSeconds: source.trimStartSeconds,
      durationSeconds: row.duration_seconds,
    });
  } catch (error) {
    if (error instanceof AudioSeparationProviderError && !error.retryable) job.discard();
    throw error;
  }

  const startOffsetSeconds = source.startOffsetSeconds;

  let result: AudioSeparationResult;
  try {
    result = await falSamAudioProvider.separate({
      model: row.model,
      audioUrl,
      prompt: row.prompt,
      durationSeconds: row.duration_seconds,
    });
  } catch (error) {
    if (error instanceof AudioSeparationProviderError && !error.retryable) job.discard();
    throw error;
  }

  // FIRST post-result action (CLAUDE.md rule #2): archive BOTH stems to R2 before ANY DB write.
  // fal's target/residual URLs are never stored or served to any client — only these R2 keys are.
  const targetKey = `audio-separation/${id}/target.mp3`;
  const residualKey = `audio-separation/${id}/residual.mp3`;
  await uploadBufferToR2(result.target, targetKey, result.mimeType);
  await uploadBufferToR2(result.residual, residualKey, result.mimeType);

  const stems = await attachSeparationStems({
    job: row,
    targetR2Key: targetKey,
    residualR2Key: residualKey,
    residualLabel: 'Everything else',
    targetLabel: row.prompt,
    startOffsetSeconds,
    sourceDepth: source.depth,
    rootClipId: source.rootClipId,
  });

  await completeAudioSeparation({
    id,
    providerRequestId: result.providerRequestId,
    targetR2Key: targetKey,
    residualR2Key: residualKey,
    targetClipId: stems.targetClipId,
    residualClipId: stems.residualClipId,
  });
}

export const audioSeparationWorker = new Worker<AudioSeparationJobPayload>(
  QUEUE_NAME,
  processAudioSeparation,
  {
    connection,
    concurrency: Math.max(1, config.audioSepWorkerConcurrency),
    limiter: { max: Math.max(1, config.audioSepRequestsPerMinute), duration: 60_000 },
  },
);

audioSeparationWorker.on('failed', async (job, error) => {
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  // Redis NX guard (CLAUDE.md rule #5 idiom, revenuecat.ts:112-113): a BullMQ retry storm or a
  // duplicate 'failed' event fire can never double-refund the same job.
  const key = `audio_sep_refund:${job.data.jobId}`;
  const isNew = await redis.set(key, '1', 'EX', 604800, 'NX');
  if (!isNew) return;
  const providerError = error instanceof AudioSeparationProviderError ? error : undefined;
  await refundAudioSeparation(
    job.data.jobId,
    providerError?.code ?? 'generation_failed',
    providerError?.retryable ? 'Separation failed after retries' : 'Separation was rejected',
  ).catch((refundError) => console.error('[audio-sep] refund failed', refundError));
});
