// src/queue/voiceoverGenerationWorker.ts
// Standalone AI Voiceover worker. Synthesizes preset/clone voices, archives the raw provider
// output to R2 immediately (CLAUDE.md Rule 2), normalizes to AAC/M4A, probes real duration,
// and completes the generation row. Retryable failures clear the lease so BullMQ retries;
// terminal failures are refunded exactly once by the on('failed') handler.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Job, Queue, Worker } from 'bullmq';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db/client';
import { projectVoiceoverGenerations } from '../db/schema';
import { uploadBufferToR2, getUploadPresignedUrl } from '../services/archivalService';
import { getAudioVoiceById } from '../config/audioVoices';
import { generateTtsWav } from '../services/geminiTtsService';
import { replicateQwenTts } from '../services/providers/ReplicateProvider';
import { probeDurationSeconds } from '../services/mediaProbe';
import {
  clearVoiceoverLease,
  completeVoiceover,
  getVoiceoverGenerationRow,
  markVoiceoverProcessing,
  readVoiceoverRaw,
  refundVoiceover,
  saveVoiceoverRaw,
} from '../services/voiceoverService';

const execFileAsync = promisify(execFile);
const QUEUE_NAME = 'voiceover-generation';
const connection = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

const VOICEOVER_LEASE_MS = 5 * 60_000;
const WORKER_CONCURRENCY = 2;
const REQUESTS_PER_MINUTE = 30;

export class VoiceoverProviderError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    public code?: string,
  ) {
    super(message);
  }
}

export interface VoiceoverGenerationJob {
  voiceoverId: string;
}

export const voiceoverGenerationQueue = new Queue<VoiceoverGenerationJob>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof VoiceoverProviderError) return error.retryable;
  if (error instanceof Error) {
    const match = error.message.match(/\((\d{3})\)/);
    if (match) {
      const status = Number(match[1]);
      return status >= 500 || status === 429;
    }
    // Network/timeouts without a status are treated as retryable.
    return true;
  }
  return true;
}

async function normalizeToM4A(id: string, rawAudio: Buffer): Promise<Buffer> {
  const workspace = await mkdtemp(path.join(tmpdir(), `voiceover-${id}-`));
  try {
    const inputPath = path.join(workspace, 'raw.wav');
    const outputPath = path.join(workspace, 'final.m4a');
    await writeFile(inputPath, rawAudio);
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
      outputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function synthesizeVoiceover(
  row: { voice_id: string; script: string; user_id: string },
): Promise<{ audio: Buffer; mimeType: string }> {
  const voice = getAudioVoiceById(row.voice_id);
  if (!voice) {
    throw new VoiceoverProviderError(`Unknown voice: ${row.voice_id}`, false, 'unknown_voice');
  }

  if (voice.kind === 'preset') {
    const audio = await generateTtsWav(
      voice.model ?? 'gemini-3.1-flash-tts-preview',
      row.script,
      voice.speaker ?? 'Kore',
    );
    return { audio, mimeType: 'audio/wav' };
  }

  if (voice.kind === 'system_clone') {
    if (!voice.referenceR2Key) {
      throw new VoiceoverProviderError('Clone voice missing reference material', false, 'missing_clone_reference');
    }
    const referenceAudioUrl = await getUploadPresignedUrl(voice.referenceR2Key);
    const audio = await replicateQwenTts({
      text: row.script,
      mode: 'voice_clone',
      referenceAudioUrl,
      referenceText: voice.referenceText,
      language: 'English',
    });
    return { audio, mimeType: 'audio/wav' };
  }

  throw new VoiceoverProviderError(`Unsupported voice kind for ${row.voice_id}`, false, 'unsupported_voice_kind');
}

export async function processVoiceoverGeneration(job: Job<VoiceoverGenerationJob>): Promise<void> {
  const id = job.data.voiceoverId;
  const token = `voiceover:${id}:${job.id ?? `${Date.now()}:${Math.random()}`}`;
  const expiresAt = new Date(Date.now() + VOICEOVER_LEASE_MS);

  const acquired = await markVoiceoverProcessing(id, token, expiresAt);
  if (!acquired) {
    const row = await getVoiceoverGenerationRow(id);
    if (!row || row.status !== 'pending') return;
    if (row.processing_token && row.processing_expires_at && new Date(row.processing_expires_at) > new Date()) {
      return;
    }
    // Lease was expired; a retry will reacquire it.
    return;
  }

  let row = await getVoiceoverGenerationRow(id);
  if (!row || row.status === 'succeeded' || row.status === 'refunded') return;

  let rawAudio: Buffer;
  let rawKey = row.raw_r2_key;
  let providerRequestId = row.provider_request_id ?? undefined;

  if (rawKey) {
    rawAudio = await readVoiceoverRaw(rawKey);
  } else {
    let synthesized: { audio: Buffer; mimeType: string };
    try {
      synthesized = await synthesizeVoiceover(row);
    } catch (error) {
      if (!isRetryableProviderError(error)) {
        job.discard();
      } else {
        await clearVoiceoverLease(id, token);
      }
      throw error;
    }

    if (!synthesized.audio || synthesized.audio.length === 0) {
      job.discard();
      throw new VoiceoverProviderError('Provider returned empty audio', false, 'empty_output');
    }

    rawAudio = synthesized.audio;
    rawKey = `voiceovers/raw/${row.user_id}/${id}`;
    await uploadBufferToR2(rawAudio, rawKey, synthesized.mimeType);
    await saveVoiceoverRaw(id, rawKey, providerRequestId);
  }

  const finalAudio = await normalizeToM4A(id, rawAudio);
  const workspace = await mkdtemp(path.join(tmpdir(), `voiceover-probe-${id}-`));
  let durationSeconds: number;
  try {
    const probePath = path.join(workspace, 'final.m4a');
    await writeFile(probePath, finalAudio);
    const probed = await probeDurationSeconds(probePath);
    if (probed == null || !Number.isFinite(probed) || probed <= 0) {
      throw new VoiceoverProviderError('Could not measure final audio duration', true, 'probe_failed');
    }
    durationSeconds = probed;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }

  const finalKey = `voiceovers/final/${row.user_id}/${id}.m4a`;
  await uploadBufferToR2(finalAudio, finalKey, 'audio/mp4');

  const completed = await completeVoiceover({
    id,
    token,
    rawR2Key: rawKey,
    finalR2Key: finalKey,
    providerRequestId,
    durationSeconds,
    mimeType: 'audio/mp4',
  });

  if (!completed) {
    throw new VoiceoverProviderError('Lease lost during completion', true, 'lease_lost');
  }
}

export const voiceoverGenerationWorker = new Worker<VoiceoverGenerationJob>(
  QUEUE_NAME,
  processVoiceoverGeneration,
  {
    connection,
    concurrency: Math.max(1, WORKER_CONCURRENCY),
    limiter: { max: Math.max(1, REQUESTS_PER_MINUTE), duration: 60_000 },
  },
);

/**
 * Refund exactly once when a job is terminally failed. Terminal means EITHER the attempts are
 * exhausted OR the job was discarded (non-retryable provider rejection — discard() skips the
 * remaining retries, so attemptsMade stays below opts.attempts and a naive attempts check would
 * never refund). The failure REASON keys off the provider error's own retryable flag, not the
 * attempt count: a discarded job is "rejected", an exhausted one "failed after retries", and a
 * non-VoiceoverProviderError (e.g. a raw provider SDK error) defaults to retryable semantics.
 */
export async function refundVoiceoverOnFailure(
  job: Job<VoiceoverGenerationJob> | undefined,
  error: unknown,
): Promise<void> {
  if (!job) return;
  const attemptsExhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
  // `discarded` is protected in bullmq's typings but is the public runtime signal that
  // discard() was called — a discarded job fails terminally without exhausting attempts.
  const discarded = (job as unknown as { discarded?: boolean }).discarded === true;
  if (!attemptsExhausted && !discarded) return;
  const providerError = error instanceof VoiceoverProviderError ? error : undefined;
  const rejected = providerError ? !providerError.retryable : false;
  await refundVoiceover(
    job.data.voiceoverId,
    providerError?.code ?? 'generation_failed',
    rejected ? 'Voiceover generation was rejected' : 'Voiceover generation failed after retries',
  ).catch((refundError) => console.error('[voiceover] refund failed', refundError));
}

voiceoverGenerationWorker.on('failed', refundVoiceoverOnFailure);

// ─── Stale-lease reaper ──────────────────────────────────────────────────────

export const voiceoverReaperQueue = new Queue('voiceover-reaper', { connection });

export async function reapStaleVoiceovers(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - VOICEOVER_LEASE_MS);
  const rows = await db.select().from(projectVoiceoverGenerations).where(and(
    eq(projectVoiceoverGenerations.status, 'processing'),
    lt(projectVoiceoverGenerations.processing_expires_at, cutoff),
  )).limit(50);

  for (const row of rows) {
    await refundVoiceover(row.id, 'lease_expired', 'Voiceover processing lease expired');
  }
}

export const voiceoverReaperWorker = new Worker(
  'voiceover-reaper',
  async () => reapStaleVoiceovers(),
  { connection, concurrency: 1 },
);

export async function scheduleVoiceoverReaper(): Promise<void> {
  await voiceoverReaperQueue.upsertJobScheduler(
    'voiceover-reaper-every-five-minutes',
    { every: 5 * 60_000 },
    { name: 'reap', data: {} },
  );
}
