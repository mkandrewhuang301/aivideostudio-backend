// Character-vlog ONE-SHOT orchestrator (v1, 2026-07-25 lock — supersedes the 7/24 multi-take
// planner worker, shelved in the descope).
//
// create mode: markProcessing → ONE cheap expansion pass (beat → {enhancedPrompt, spokenLine},
// SILENT during creation — magic = type a thing, get a video) → qwen3-tts voice_clone of the
// spoken line (skipped on silent beats or while the character has no voice asset — Mini rolls
// its own voice then) → ONE Seedance Mini clip (character sheet as reference_images, per-beat
// clone audio as reference_audios — voice identity + lip-sync in one mechanism) → markCompleted
// + APNs DIRECTLY: one clip needs no ffmpeg concat, and this is never a real-face path so the
// ffmpegWorker Hive gate doesn't apply. Any failure = full refund (explainer precedent).
//
// regen mode: re-films the ONE persisted take with its persisted resolved_prompt and persisted
// clone audio (same words, same voice — v1 re-rolls visuals only, spec O-5), archives to a NEW
// attempt key so the old clip survives a failed attempt, swaps the pointer, markCompleted +
// APNs. Failure = take-cost refund + row restored to 'completed' (the original clip is intact).

import { Job, Worker } from 'bullmq';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { SERVER_CHARACTERS, type CharacterVlogConfig } from '../config/characters';
import { replicateQwenTts, runVlogTake } from '../services/providers/ReplicateProvider';
import { buildClipPrompt, expandVlogBeat } from '../services/vlogExpansionService';
import { uploadBufferToR2 } from '../services/archivalService';
import { sendGenerationComplete } from '../services/apnsService';
import { r2, R2_BUCKET } from '../storage/r2';
import { refundCredits } from '../services/creditService';
import {
  classifyFailureReason,
  getGenerationById,
  markCompleted,
  markFailed,
  markProcessing,
  markRegenerating,
  mergeGenerationParams,
  restoreCompletedAfterRegenFailure,
} from '../services/generationService';
import type { VlogGenerationJob } from './vlogGenerationQueue';

const QUEUE_NAME = 'vlog-generation';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

/** Persisted per-take unit — the clip is addressable: resolved prompt + voice + clip, so the
 *  detail screen can show "prompt used" and regen can re-roll without re-expanding. v1 has
 *  exactly ONE take per generation; the array shape survives for the post-launch chaining flip. */
export interface VlogTakeUnit {
  index: number;
  status: 'filming' | 'done' | 'regenerating' | 'failed';
  duration_seconds: number;
  /** '' = silent beat (no TTS was run, Mini got no reference_audios). */
  spoken_line: string;
  /** The exact Mini prompt — user-visible on the take screen. */
  resolved_prompt: string;
  /** Per-beat qwen clone WAV (this take's spoken line in the character's voice). Reused on
   *  regen — re-rolling it would change the delivery, and regen is visuals-only. */
  voice_r2_key: string | null;
  clip_r2_key: string | null;
  attempts: number;
}

function requireVlogCharacter(characterId: string): { name: string; vlog: CharacterVlogConfig } {
  const character = SERVER_CHARACTERS.find((def) => def.character_id === characterId);
  if (!character?.vlog) throw new Error(`Unknown vlog character ${characterId}`);
  return { name: character.name, vlog: character.vlog };
}

async function presignKey(key: string): Promise<string> {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 3600 });
}

/**
 * qwen3-tts voice_clone stage: the character's canonical reference clip clones THIS beat's
 * spoken line → per-beat WAV archived to R2 (Mini's reference_audios wants a URL; we persist
 * the key and presign at film/regen time). Throws on any qwen failure — fail-closed like the
 * expansion pass: a wrong-voice clip is worth less than the refund.
 */
async function recordVoice(
  generationId: string,
  take: VlogTakeUnit,
  character: CharacterVlogConfig,
  attempt: number,
): Promise<string> {
  if (!character.voice_reference_r2_key) {
    throw new Error('recordVoice called with no voice_reference_r2_key configured');
  }
  const wav = await replicateQwenTts({
    text: take.spoken_line,
    mode: 'voice_clone',
    referenceAudioUrl: await presignKey(character.voice_reference_r2_key),
    referenceText: character.voice_reference_text,
    styleInstruction: character.default_voice_direction,
  });
  const key = `generations/${generationId}/take_${take.index}_voice_a${attempt}.wav`;
  await uploadBufferToR2(wav, key, 'audio/wav');
  return key;
}

/** One Mini clip: character sheet as reference_images + per-beat clone audio as
 *  reference_audios (E006-legal — the ban is on reference inputs with FIRST/LAST-FRAME
 *  images, which this path never uses). The shelved still stage flips back in via config. */
async function filmTake(
  generationId: string,
  take: VlogTakeUnit,
  character: CharacterVlogConfig,
  clipKey: string,
): Promise<string> {
  if (!character.sheet_r2_key) throw new Error('character has no sheet_r2_key (O-3 asset missing)');
  return runVlogTake(
    {
      prompt: take.resolved_prompt,
      durationSeconds: take.duration_seconds,
      referenceImages: [await presignKey(character.sheet_r2_key)],
      referenceAudios: take.voice_r2_key ? [await presignKey(take.voice_r2_key)] : undefined,
    },
    clipKey,
  );
}

/** One-clip completion — no ffmpeg hop. Mirrors ffmpegWorker's markCompleted + APNs block
 *  (best-effort push, never fails the paid pipeline over a notification). */
async function completeGeneration(generationId: string, userId: string, r2Key: string): Promise<void> {
  const completed = await markCompleted(generationId, r2Key);
  if (!completed) return;
  try {
    const userRows = await db.execute(sql`SELECT apns_device_token FROM users WHERE id = ${userId}::uuid`);
    const token = (userRows.rows?.[0] as { apns_device_token: string | null } | undefined)?.apns_device_token;
    if (token) await sendGenerationComplete(token, generationId, 'video');
  } catch (pushErr) {
    console.error('[vlog-generation] Push notification failed (non-blocking):', pushErr);
  }
}

async function processCreateJob(data: Extract<VlogGenerationJob, { mode: 'create' }>): Promise<void> {
  try {
    // If the pending row was already reaped/refunded while queued, spend nothing and do not
    // issue a second refund (explainer precedent).
    const started = await markProcessing(data.generationId);
    if (!started) {
      console.warn(`[vlog-generation] ${data.generationId} no longer pending — skipping (reaped while queued?)`);
      return;
    }
    const character = requireVlogCharacter(data.characterId);

    // Progress is best-effort bookkeeping. A label write can never fail the paid pipeline.
    const stampStage = (patch: { stage_label: string }) => (
      mergeGenerationParams(data.generationId, patch).catch(() => {})
    );

    await stampStage({ stage_label: 'Writing the beat…' });
    const expansion = await expandVlogBeat({
      character: character.vlog,
      beat: data.beat,
      durationSeconds: data.durationSeconds,
    });
    const take: VlogTakeUnit = {
      index: 0,
      status: 'filming',
      duration_seconds: data.durationSeconds,
      spoken_line: expansion.spokenLine,
      resolved_prompt: buildClipPrompt(character.vlog, expansion),
      voice_r2_key: null,
      clip_r2_key: null,
      attempts: 1,
    };
    const takes = [take];
    await mergeGenerationParams(data.generationId, {
      character_id: data.characterId,
      duration_seconds: data.durationSeconds,
      expansion_model: 'anthropic/claude-3.5-haiku',
      takes,
    });

    // Voice stage: spoken line + configured clone reference → per-beat qwen audio. Silent
    // beats and missing voice assets both legitimately skip (Mini rolls its own voice).
    if (take.spoken_line && character.vlog.voice_reference_r2_key) {
      await stampStage({ stage_label: 'Recording the voice…' });
      take.voice_r2_key = await recordVoice(data.generationId, take, character.vlog, take.attempts);
      await mergeGenerationParams(data.generationId, { takes });
    }

    await stampStage({ stage_label: 'Filming…' });
    take.clip_r2_key = await filmTake(
      data.generationId,
      take,
      character.vlog,
      `generations/${data.generationId}/take_${take.index}.mp4`,
    );
    take.status = 'done';
    await mergeGenerationParams(data.generationId, { takes, stage_label: '' });

    await completeGeneration(data.generationId, data.userId, take.clip_r2_key);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[vlog-generation] pipeline failed for ${data.generationId}: ${errMsg}`);
    await markFailed(data.generationId, classifyFailureReason(errMsg));
    await refundCredits(data.userId, data.cost, `vlog-failure-${data.generationId}`);
  }
}

async function processRegenJob(data: Extract<VlogGenerationJob, { mode: 'regen' }>): Promise<void> {
  try {
    const generation = await getGenerationById(data.generationId, data.userId);
    const params = generation?.params as Record<string, unknown> | null;
    if (!generation || params?.format_id !== 'character-vlog') {
      throw new Error('Generation is not a character-vlog');
    }
    const takes = (params.takes ?? []) as VlogTakeUnit[];
    const take = takes[data.takeIndex];
    if (!take) throw new Error(`Unknown take ${data.takeIndex}`);
    if (take.status !== 'done') throw new Error(`Take ${data.takeIndex} is not regenerable (${take.status})`);
    const character = requireVlogCharacter(
      typeof params.character_id === 'string' ? params.character_id : '',
    );

    // Flips the row back to 'processing' so markCompleted + APNs work exactly like the
    // initial run.
    const flipped = await markRegenerating(data.generationId);
    if (!flipped) throw new Error('Generation is not in a regenerable state');

    take.status = 'regenerating';
    await mergeGenerationParams(data.generationId, { takes, stage_label: 'Re-filming…' });

    // Visuals-only re-roll (spec O-5): reuse the persisted resolved_prompt AND the persisted
    // clone audio. A legacy take with a spoken line but no archived voice re-records it once.
    const attempt = take.attempts + 1;
    if (!take.voice_r2_key && take.spoken_line && character.vlog.voice_reference_r2_key) {
      take.voice_r2_key = await recordVoice(data.generationId, take, character.vlog, attempt);
    }
    // NEW key per attempt: the old clip survives a failed re-film; the pointer swaps on success.
    const clipKey = await filmTake(
      data.generationId,
      take,
      character.vlog,
      `generations/${data.generationId}/take_${take.index}_a${attempt}.mp4`,
    );
    take.clip_r2_key = clipKey;
    take.attempts = attempt;
    take.status = 'done';
    await mergeGenerationParams(data.generationId, { takes, stage_label: '' });

    await completeGeneration(data.generationId, data.userId, take.clip_r2_key);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[vlog-generation] take regen failed for ${data.generationId} take ${data.takeIndex}: ${errMsg}`);
    // Restore the take pointer + row status — the original take clip and final video are intact.
    try {
      const generation = await getGenerationById(data.generationId, data.userId);
      const takes = ((generation?.params as Record<string, unknown> | null)?.takes ?? []) as VlogTakeUnit[];
      const take = takes[data.takeIndex];
      if (take && take.status === 'regenerating') {
        take.status = 'done';
        await mergeGenerationParams(data.generationId, { takes, stage_label: '' });
      }
      await restoreCompletedAfterRegenFailure(data.generationId);
    } catch (restoreErr) {
      console.error('[vlog-generation] regen state restore failed (non-blocking):', restoreErr);
    }
    await refundCredits(data.userId, data.cost, `vlog-regen-failure-${data.generationId}-${data.takeIndex}`);
  }
}

export async function processVlogGeneration(data: VlogGenerationJob): Promise<void> {
  if (data.mode === 'regen') {
    await processRegenJob(data);
  } else {
    await processCreateJob(data);
  }
}

export const vlogGenerationWorker = new Worker<VlogGenerationJob>(
  QUEUE_NAME,
  async (job: Job<VlogGenerationJob>) => {
    await processVlogGeneration(job.data);
  },
  { connection: connectionOptions },
);

vlogGenerationWorker.on('completed', (job) => {
  console.log(`[vlog-generation] Job ${job.id} completed`);
});

vlogGenerationWorker.on('failed', (job, err) => {
  console.error(`[vlog-generation] Job ${job?.id} failed:`, err);
});
