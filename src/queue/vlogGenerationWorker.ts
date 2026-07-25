// Character-vlog multi-take orchestrator (gorilla, 2026-07-24 spec §3/§9).
//
// plan mode: markProcessing → Sonnet-5 planner → N Seedance Mini takes (SYNCHRONOUS
// replicate.run per take, explainer-style — the row's single replicate_prediction_id column
// can't track N takes through the webhook) → one ffmpeg concat → markCompleted + APNs happen
// in ffmpegWorker. Any failure = full refund (explainer precedent).
//
// regen mode: re-films ONE persisted take with its persisted resolved_prompt + refs (same
// spoken line — v1 re-rolls visuals only, spec O-5), archives to a NEW attempt key so the old
// clip survives a failed attempt, swaps the pointer, re-stitches. Failure = take-cost refund +
// row restored to 'completed' (the original final video is still intact).

import { Job, Worker } from 'bullmq';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SERVER_CHARACTERS, type CharacterVlogConfig } from '../config/characters';
import { generateVlogStill, runVlogTake } from '../services/providers/ReplicateProvider';
import { r2, R2_BUCKET } from '../storage/r2';
import { refundCredits } from '../services/creditService';
import {
  classifyFailureReason,
  getGenerationById,
  markFailed,
  markProcessing,
  markRegenerating,
  mergeGenerationParams,
  restoreCompletedAfterRegenFailure,
} from '../services/generationService';
import {
  allocateTakes,
  buildTakePrompt,
  buildTakeStillPrompt,
  planVlogTakes,
  type PlannedTake,
} from '../services/vlogPlannerService';
import { ffmpegQueue } from './ffmpegWorker';
import type { VlogGenerationJob } from './vlogGenerationQueue';

const QUEUE_NAME = 'vlog-generation';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

/** Persisted per-take unit (spec §10) — takes are addressable: resolved prompt + refs + clip. */
export interface VlogTakeUnit {
  index: number;
  status: 'planned' | 'filming' | 'done' | 'regenerating' | 'failed';
  duration_seconds: number;
  setting: string;
  setting_tag: string;
  framing_tag: string;
  visual_direction: string;
  spoken_line: string;
  voice_direction: string;
  /** The exact Mini prompt — user-visible on the take screen. */
  resolved_prompt: string;
  reference_images: string[];
  /** Empty until the character's pinned qwen-clone voice asset exists (spec O-3). */
  reference_audios: string[];
  /** Frame-first (7/25 arm-C lock): the gpt-image-2 still Mini gets as reference_images[0].
   *  Persisted so regen can re-roll the still and the take screen can show it. */
  still_r2_key: string | null;
  still_prompt: string | null;
  clip_r2_key: string | null;
  attempts: number;
}

function requireVlogCharacter(characterId: string): { name: string; vlog: CharacterVlogConfig } {
  const character = SERVER_CHARACTERS.find((def) => def.character_id === characterId);
  if (!character?.vlog) throw new Error(`Unknown vlog character ${characterId}`);
  return { name: character.name, vlog: character.vlog };
}

function takeUnitFromPlan(
  planned: PlannedTake,
  index: number,
  character: CharacterVlogConfig,
): VlogTakeUnit {
  return {
    index,
    status: 'planned',
    duration_seconds: planned.duration_seconds,
    setting: planned.setting,
    setting_tag: planned.setting_tag,
    framing_tag: planned.framing_tag,
    visual_direction: planned.visual_direction,
    spoken_line: planned.spoken_line,
    voice_direction: planned.voice_direction || character.default_voice_direction,
    resolved_prompt: buildTakePrompt(character, planned),
    reference_images: [], // populated by filmTake with the per-take STILL (arm-C), not the sheet
    reference_audios: character.voice_asset_url ? [character.voice_asset_url] : [],
    still_r2_key: null,
    still_prompt: null,
    clip_r2_key: null,
    attempts: 0,
  };
}

async function presignKey(key: string): Promise<string> {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 3600 });
}

/**
 * Frame-first film (2026-07-25 arm-C lock, replacing the text-only sheet-reference path):
 * gpt-image-2 renders the take's still FROM the character sheet → Mini films with the STILL as
 * reference_images[0] (+ voice pin when the asset exists). First-frame `image` mode is NOT
 * used — E006 bans it with reference_audios, and the still-as-reference arm matched its scene
 * fidelity in the live A/B/C smoke while keeping the voice pin.
 */
async function filmTake(
  generationId: string,
  take: VlogTakeUnit,
  character: CharacterVlogConfig,
  clipKey: string,
  stillKey: string,
): Promise<string> {
  if (!character.sheet_r2_key) throw new Error('character has no sheet_r2_key (O-3 asset missing)');
  const sheetUrl = await presignKey(character.sheet_r2_key);
  const takePlan: PlannedTake = {
    take_index: take.index,
    duration_seconds: take.duration_seconds,
    setting: take.setting,
    setting_tag: take.setting_tag,
    framing_tag: take.framing_tag,
    visual_direction: take.visual_direction,
    spoken_line: take.spoken_line,
    voice_direction: take.voice_direction,
  };
  take.still_prompt = buildTakeStillPrompt(character, takePlan);
  take.still_r2_key = await generateVlogStill(take.still_prompt, sheetUrl, stillKey);
  take.reference_images = [await presignKey(take.still_r2_key)];
  return runVlogTake(
    {
      prompt: take.resolved_prompt,
      durationSeconds: take.duration_seconds,
      referenceImages: take.reference_images,
      referenceAudios: take.reference_audios.length ? take.reference_audios : undefined,
    },
    clipKey,
  );
}

async function enqueueConcat(
  generationId: string,
  userId: string,
  costCredits: number,
  takes: VlogTakeUnit[],
): Promise<void> {
  await ffmpegQueue.add('generate', {
    generationId,
    userId,
    // Refund basis if stitching permanently fails: full cost on the initial run, the single
    // take's cost on regen.
    costCredits,
    op: 'concat',
    inputR2Keys: takes.map((take) => take.clip_r2_key!),
    mediaType: 'video',
  });
}

async function processPlanJob(data: Extract<VlogGenerationJob, { mode: 'plan' }>): Promise<void> {
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

    await stampStage({ stage_label: 'Planning your vlog…' });
    const takeSeconds = allocateTakes(data.totalSeconds);
    const planned = await planVlogTakes({
      character: character.vlog,
      topic: data.topic,
      vibe: data.vibe,
      takeSeconds,
    });
    const takes = planned.map((take, index) => takeUnitFromPlan(take, index, character.vlog));
    await mergeGenerationParams(data.generationId, {
      character_id: data.characterId,
      total_seconds: data.totalSeconds,
      planner_model: 'anthropic/claude-sonnet-5',
      takes,
    });

    // Sequential takes (spec §3): independent in principle, but Replicate burst limits and the
    // simple full-refund failure model win over wall-clock. Revisit if users complain.
    for (const take of takes) {
      await stampStage({ stage_label: `Filming take ${take.index + 1}/${takes.length}…` });
      take.status = 'filming';
      await mergeGenerationParams(data.generationId, { takes });
      take.clip_r2_key = await filmTake(
        data.generationId,
        take,
        character.vlog,
        `generations/${data.generationId}/take_${take.index}.mp4`,
        `generations/${data.generationId}/take_${take.index}_still.png`,
      );
      take.status = 'done';
      take.attempts = 1;
      // Persist after EACH take — a late failure leaves an inspectable trail, and the take is
      // never re-filmed on a manual retry of the stitch.
      await mergeGenerationParams(data.generationId, { takes });
    }

    await stampStage({ stage_label: 'Stitching…' });
    await enqueueConcat(data.generationId, data.userId, data.cost, takes);
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

    // Flips the row back to 'processing' so ffmpegWorker's markCompleted + APNs path works on
    // the re-stitch exactly like the initial run.
    const flipped = await markRegenerating(data.generationId);
    if (!flipped) throw new Error('Generation is not in a regenerable state');

    take.status = 'regenerating';
    await mergeGenerationParams(data.generationId, { takes, stage_label: `Re-filming take ${take.index + 1}…` });

    // NEW keys per attempt: the old clip AND old still survive a failed re-film, and the
    // pointers only swap on success. Regen re-rolls BOTH still and clip (visuals only —
    // same spoken line, spec O-5).
    const attempt = take.attempts + 1;
    const clipKey = await filmTake(
      data.generationId,
      take,
      character.vlog,
      `generations/${data.generationId}/take_${take.index}_a${attempt}.mp4`,
      `generations/${data.generationId}/take_${take.index}_still_a${attempt}.png`,
    );
    take.clip_r2_key = clipKey;
    take.attempts = attempt;
    take.status = 'done';
    await mergeGenerationParams(data.generationId, { takes, stage_label: 'Stitching…' });

    await enqueueConcat(data.generationId, data.userId, data.cost, takes);
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
    await processPlanJob(data);
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
