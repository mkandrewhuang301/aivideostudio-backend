// Multi-stage Explainer orchestrator. Provider work is sequential per scene so the scene's real
// narration duration drives its single winning Omni clip, then one ffmpeg job owns final assembly.

import { Job, Worker } from 'bullmq';
import { FORMATS_BY_ID, type FormatAspectRatio } from '../config/formats';
import { getGenerationPresignedUrl, uploadBufferToR2 } from '../services/archivalService';
import { refundCredits } from '../services/creditService';
import {
  EXPLAINER_NARRATION_TEMPO,
  EXPLAINER_VOICE_STYLE_PROMPT,
  generateNarrationForScene,
  resolveExplainerVoice,
  resolveExplainerVoiceName,
  type NarrationStem,
} from '../services/geminiTtsService';
import {
  classifyFailureReason,
  markFailed,
  markProcessing,
  mergeGenerationParams,
} from '../services/generationService';
import { generateMusicBed } from '../services/lyriaService';
import { allocateMotionBudget } from '../services/explainerMotionAllocator';
import { expandExplainerScript } from '../services/openaiScriptService';
import { resolveVisualStage } from '../services/explainerVisualStage';
import { buildGroundingText } from '../services/sourceGroundingService';
import { concatWavBuffers } from '../services/wavUtil';
import { buildSceneCues, getWordTimings } from '../services/whisperxService';
import type { CaptionWordDraft } from '../services/captionTranscriptionService';
import type { ExplainerGenerationJob } from './explainerGenerationQueue';
import { ffmpegQueue } from './ffmpegWorker';

const QUEUE_NAME = 'explainer-generation';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

async function downloadArchivedBuffer(r2Key: string): Promise<Buffer> {
  const url = await getGenerationPresignedUrl(r2Key);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Archived narration download failed (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// WhisperX runs over the concatenated narration, so its word times are already global. The
// existing cue builder accepts scene-local words plus cumulative offsets; localize each slice
// first so the offset is applied exactly once.
function localizeWordsForSceneCues(
  sceneNarrations: string[],
  words: CaptionWordDraft[],
  sceneStartOffsets: number[],
): CaptionWordDraft[] {
  let cursor = 0;
  return sceneNarrations.flatMap((narration, sceneIndex) => {
    const wordCount = narration.trim() ? narration.trim().split(/\s+/).length : 0;
    const offset = sceneStartOffsets[sceneIndex] ?? 0;
    const sceneWords = words.slice(cursor, cursor + wordCount).map((word) => ({
      text: word.text,
      startSeconds: Math.max(0, word.startSeconds - offset),
      endSeconds: Math.max(0, word.endSeconds - offset),
    }));
    cursor += wordCount;
    return sceneWords;
  });
}

export async function processExplainerGeneration(data: ExplainerGenerationJob): Promise<void> {
  try {
    // FIRST: if the pending row was already reaped/refunded while queued, spend nothing and do
    // not issue a second refund.
    const started = await markProcessing(data.generationId);
    if (!started) {
      console.warn(
        `[explainer-generation] ${data.generationId} no longer pending — skipping (reaped while queued?)`,
      );
      return;
    }

    const def = FORMATS_BY_ID[data.formatId];
    if (!def) throw new Error(`Unknown format ${data.formatId}`);
    const style = def.style_grid.find((candidate) => candidate.id === data.styleId);
    if (!style) throw new Error(`Unknown style ${data.styleId}`);
    if (!def.aspect_ratios.includes(data.aspectRatio as FormatAspectRatio)) {
      throw new Error(`Unknown aspect ratio ${data.aspectRatio}`);
    }
    const aspectRatio = data.aspectRatio as FormatAspectRatio;

    // Progress is best-effort bookkeeping. A label write can never fail the paid pipeline.
    const stampStage = (patch: { stage_label: string }) => (
      mergeGenerationParams(data.generationId, patch).catch(() => {})
    );

    let groundingText: string | undefined;
    try {
      const attachmentUrls = await Promise.all(data.attachments.map(async (attachment) => ({
        url: await getGenerationPresignedUrl(attachment.r2Key),
        mimeType: attachment.mimeType,
      })));
      groundingText = (await buildGroundingText(attachmentUrls, data.sourceUrl)) || undefined;
    } catch {
      console.warn(`[explainer-generation] Grounding unavailable for ${data.generationId}; continuing`);
    }

    await stampStage({ stage_label: 'Writing script…' });
    const script = await expandExplainerScript({
      topic: data.topic,
      sceneCount: data.sceneCount,
      styleLabel: style.label,
      scriptTemplate: def.script_template,
      groundingText,
      visualMethod: data.visualMethod,
      // Pre-atempo spoken-duration budget: the script should write enough narration that, AFTER
      // the EXPLAINER_NARRATION_TEMPO speed-up below, the final video lands near data.durationSeconds
      // instead of v3's 77s-for-a-30s-tier overshoot.
      targetTotalSeconds: data.durationSeconds * EXPLAINER_NARRATION_TEMPO,
    });

    // Kicked off immediately (only needs script.music_mood) and awaited at compose time, so Lyria
    // generation overlaps the per-scene narration/visual loop below instead of sitting on the
    // critical path after it (2026-07-23 speed pass). The .catch here is deliberate: it attaches a
    // handler synchronously so a rejection before the later await can never surface as an unhandled
    // promise rejection; the resolved { error } is turned back into a throw at the await site so
    // failure handling (refund, classifyFailureReason) is unchanged.
    const resolvedMood = data.music === 'auto' ? script.music_mood : data.music;
    const musicPromise = generateMusicBed(resolvedMood, def.music_model, data.generationId)
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    // Nano-motion budget allocation (illustrated tier only; harmless no-op for animated since
    // that stage never reads motion/resolvedNano). Looked up by durationSeconds rather than
    // threaded as its own job field — the tier row is the single source of truth for edit_budget.
    const tier = def.duration_tiers.find((candidate) => candidate.seconds === data.durationSeconds);
    const motionAllocation = allocateMotionBudget(script.scenes, tier?.edit_budget ?? 0);

    // VLM image-judge regeneration budget (2026-07-25, LOCKED): ceil(sceneCount * 0.25), min 2,
    // shared across every scene — 12 scenes→3, 24→6, 36→9. The judge still CHECKS every still
    // after the budget is spent; it just stops paying for regenerations (fail-open always).
    const regenBudget = { remaining: Math.max(2, Math.ceil(script.scenes.length * 0.25)) };

    const anchorUrl = await getGenerationPresignedUrl(style.anchor_r2_key);
    // Resolved ONCE, not per scene (2026-07-24 TTS routing flip): the same voice renders every
    // stem, and the clone branch presigns a reference URL. `voice` is undefined for preset Gemini
    // voices → narration takes the native Gemini path with the validated `voiceName` (Kore
    // default); only a custom clone id (voiceA) builds a qwen voice_clone.
    const narrationVoiceName = resolveExplainerVoiceName(data.voiceId);
    const narrationVoice = await resolveExplainerVoice(data.voiceId);
    const stems: NarrationStem[] = [];
    const clipKeys: string[] = [];

    for (let sceneIndex = 0; sceneIndex < script.scenes.length; sceneIndex += 1) {
      const scene = script.scenes[sceneIndex]!;
      if (sceneIndex === 0) await stampStage({ stage_label: 'Recording narration…' });
      const stem = await generateNarrationForScene(
        scene.narration_line,
        narrationVoiceName,
        def.tts_model,
        data.generationId,
        sceneIndex,
        EXPLAINER_VOICE_STYLE_PROMPT,
        EXPLAINER_NARRATION_TEMPO,
        narrationVoice,
      );
      stems.push(stem);

      if (sceneIndex === 0) {
        await stampStage({
          stage_label: data.visualMethod === 'illustrated' ? 'Illustrating scenes…' : 'Animating scenes…',
        });
      }
      // Swappable visual stage (CLAUDE.md rule 6): illustrated = gpt-image-2-low still -> ffmpeg
      // Ken-Burns; animated = still -> Omni. The stage generates its own still internally.
      const { clipR2Key } = await resolveVisualStage(data.visualMethod).generateSceneClip({
        generationId: data.generationId,
        sceneIndex,
        visualPrompt: scene.visual_prompt,
        motionPrompt: scene.motion_prompt,
        styleAnchorUrl: anchorUrl,
        imageModel: def.image_model,
        omniModel: def.omni_model,
        narrationDurationSeconds: stem.durationSeconds,
        aspectRatio,
        motion: scene.motion,
        resolvedNano: motionAllocation[sceneIndex]?.resolvedNano ?? false,
        onImageText: scene.on_image_text,
        textZone: scene.text_zone,
        regenBudget,
        styleLabel: style.label,
      });
      clipKeys.push(clipR2Key);
    }

    const stemBuffers = await Promise.all(stems.map((stem) => downloadArchivedBuffer(stem.r2Key)));
    const narrationBuffer = concatWavBuffers(stemBuffers);
    const narrationKey = `generations/${data.generationId}.narration.wav`;
    await uploadBufferToR2(narrationBuffer, narrationKey, 'audio/wav');

    const sceneStartOffsets: number[] = [];
    let cumulativeDuration = 0;
    for (const stem of stems) {
      sceneStartOffsets.push(cumulativeDuration);
      cumulativeDuration += stem.durationSeconds;
    }
    const scriptWords = script.scenes.flatMap((scene) => (
      scene.narration_line.split(/\s+/).filter(Boolean)
    ));
    const words = await getWordTimings(
      await getGenerationPresignedUrl(narrationKey),
      scriptWords,
      cumulativeDuration,
    );
    const sceneNarrations = script.scenes.map((scene) => scene.narration_line);
    const cues = buildSceneCues(
      sceneNarrations,
      localizeWordsForSceneCues(sceneNarrations, words, sceneStartOffsets),
      sceneStartOffsets,
    );

    await stampStage({ stage_label: 'Scoring…' });
    // Lyria was kicked off right after the script resolved (2026-07-23 speed pass) and has been
    // running concurrently with the scene loop/WhisperX above; this is just picking up the result.
    // A caught rejection surfaces here as a real throw so failure handling (refund,
    // classifyFailureReason) behaves exactly as it did when this call was inline.
    const musicOutcome = await musicPromise;
    if (!musicOutcome.ok) throw musicOutcome.error;
    const music = musicOutcome.result;

    await mergeGenerationParams(data.generationId, {
      format_id: data.formatId,
      structured: {
        audioStems: [{ r2Key: narrationKey, sourceType: 'narration' }],
        captionCues: cues.map((cue) => ({
          startSeconds: cue.startSeconds,
          endSeconds: cue.endSeconds,
          words: cue.words.map((word) => ({
            text: word.text,
            startSeconds: word.startSeconds,
            endSeconds: word.endSeconds,
          })),
        })),
      },
    });

    const canvas = aspectRatio === '16:9'
      ? { width: 1920, height: 1080 }
      : { width: 1080, height: 1920 };
    await stampStage({ stage_label: 'Rendering…' });
    await ffmpegQueue.add('generate', {
      generationId: data.generationId,
      userId: data.userId,
      costCredits: data.cost,
      op: 'explainer_compose',
      inputR2Keys: clipKeys,
      mediaType: 'video',
      explainerCompose: {
        ...canvas,
        fps: 25,
        clips: script.scenes.map((scene, index) => ({
          r2Key: clipKeys[index]!,
          durationSeconds: stems[index]!.durationSeconds,
          transition: scene.transition_out ?? 'cut',
        })),
        narrationR2Key: narrationKey,
        musicR2Key: music?.r2Key ?? null,
        musicVolume: 0.18,
        captionCues: cues,
        captionStyle: {
          fontSize: def.caption_style.fontSize,
          color: def.caption_style.textColor,
          highlightColor: def.caption_style.highlightColor,
          position: def.caption_style.position,
          outlineWidth: def.caption_style.outlineWidth,
          shadowDepth: def.caption_style.shadowDepth,
          backgroundBox: def.caption_style.backgroundBox,
        },
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[explainer-generation] pipeline failed for ${data.generationId}: ${errMsg}`);
    await markFailed(data.generationId, classifyFailureReason(errMsg));
    await refundCredits(data.userId, data.cost, `explainer-failure-${data.generationId}`);
  }
}

export const explainerGenerationWorker = new Worker<ExplainerGenerationJob>(
  QUEUE_NAME,
  (job: Job<ExplainerGenerationJob>) => processExplainerGeneration(job.data),
  { connection: connectionOptions, concurrency: 2 },
);

explainerGenerationWorker.on('failed', (job, err) => {
  console.error(`[explainer-generation] Job ${job?.id} failed unexpectedly:`, err);
});
