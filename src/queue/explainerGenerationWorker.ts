// Multi-stage Explainer orchestrator. Provider work is sequential per scene so the scene's real
// narration duration drives its single winning Omni clip, then one ffmpeg job owns final assembly.

import { Job, Worker } from 'bullmq';
import { config } from '../config';
import { FORMATS_BY_ID, type FormatAspectRatio } from '../config/formats';
import { getGenerationPresignedUrl, uploadBufferToR2 } from '../services/archivalService';
import { refundCredits } from '../services/creditService';
import { generateNarrationForScene, type NarrationStem } from '../services/geminiTtsService';
import {
  classifyFailureReason,
  markFailed,
  markProcessing,
  mergeGenerationParams,
} from '../services/generationService';
import { scanForCsam } from '../services/hiveService';
import { generateMusicBed } from '../services/lyriaService';
import { animateScene } from '../services/omniService';
import { expandExplainerScript, pickBestCandidateIndex } from '../services/openaiScriptService';
import { generateStyledStill } from '../services/providers/ReplicateProvider';
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
    });

    const anchorUrl = await getGenerationPresignedUrl(style.anchor_r2_key);
    const stems: NarrationStem[] = [];
    const clipKeys: string[] = [];

    for (let sceneIndex = 0; sceneIndex < script.scenes.length; sceneIndex += 1) {
      const scene = script.scenes[sceneIndex]!;
      if (sceneIndex === 0) await stampStage({ stage_label: 'Recording narration…' });
      const stem = await generateNarrationForScene(
        scene.narration_line,
        data.voiceId,
        def.tts_model,
        data.generationId,
        sceneIndex,
      );
      stems.push(stem);

      if (sceneIndex === 0) await stampStage({ stage_label: 'Illustrating scenes…' });
      const candidateKeys: string[] = [];
      for (let candidateIndex = 0; candidateIndex < def.candidate_still_count; candidateIndex += 1) {
        candidateKeys.push(await generateStyledStill(
          scene.visual_prompt,
          anchorUrl,
          def.image_model,
          `${data.generationId}.scene${sceneIndex}.candidate${candidateIndex}`,
        ));
      }
      const candidateUrls = await Promise.all(
        candidateKeys.map((key) => getGenerationPresignedUrl(key)),
      );

      let winnerIndex = 0;
      try {
        const pickedIndex = await pickBestCandidateIndex(
          candidateUrls,
          scene.visual_prompt,
          scene.text_zone,
        );
        if (Number.isInteger(pickedIndex) && pickedIndex >= 0 && pickedIndex < candidateUrls.length) {
          winnerIndex = pickedIndex;
        }
      } catch {
        console.warn(`[explainer-generation] Vision pick unavailable for scene ${sceneIndex}; using candidate 0`);
      }

      if (config.hiveScanEnabled) {
        const { flagged } = await scanForCsam(candidateKeys[winnerIndex]!);
        if (flagged) throw new Error(`CSAM scan flagged scene ${sceneIndex} winning still`);
      }

      if (sceneIndex === 0) await stampStage({ stage_label: 'Animating…' });
      const clip = await animateScene(
        candidateUrls[winnerIndex]!,
        scene.motion_prompt,
        def.omni_model,
        aspectRatio,
        stem.durationSeconds,
        data.generationId,
        sceneIndex,
      );
      clipKeys.push(clip.r2Key);
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

    const resolvedMood = data.music === 'auto' ? script.music_mood : data.music;
    await stampStage({ stage_label: 'Scoring…' });
    const music = await generateMusicBed(resolvedMood, def.music_model, data.generationId);

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
        clips: script.scenes.map((_scene, index) => ({
          r2Key: clipKeys[index]!,
          durationSeconds: stems[index]!.durationSeconds,
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
