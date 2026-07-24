// AutoSummary orchestrator: download the owned episode, add dense local motion hints, ask Gemini
// for a grounded chronological edit plan, synthesize narration, and hand a timestamped source-cut
// spec to the existing ffmpeg completion pipeline.

import { Job, Worker } from 'bullmq';
import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { FORMATS_BY_ID } from '../config/formats';
import { getUploadPresignedUrl, getGenerationPresignedUrl, uploadBufferToR2 } from '../services/archivalService';
import { refundCredits } from '../services/creditService';
import { generateNarrationForScene, type NarrationStem, type NarrationVoice } from '../services/geminiTtsService';
import { generateMusicBed } from '../services/lyriaService';
import {
  classifyFailureReason,
  markFailed,
  markProcessing,
  mergeGenerationParams,
} from '../services/generationService';
import {
  analyzeActionWindows,
  extractEmbeddedSubtitleText,
  planVideoSummary,
  type VideoSummaryClip,
} from '../services/videoSummaryService';
import { concatWavBuffers } from '../services/wavUtil';
import { buildSceneCues, getWordTimings } from '../services/whisperxService';
import type { CaptionWordDraft } from '../services/captionTranscriptionService';
import type { VideoSummaryJob } from './videoSummaryQueue';
import { ffmpegQueue, type SummarySourceClipSpec } from './ffmpegWorker';

const QUEUE_NAME = 'video-summary';
/**
 * Delivery direction. Deliberately asks for a BRISK read rather than the "clear, measured
 * conversational pace" this used to request — a slow open loses the feed before the story lands.
 * Pace is asked for once, here; the remaining lines still suppress the theatrical/drawn-out
 * failure modes that made an earlier speed attempt sound bad.
 */
export const VIDEO_SUMMARY_VOICE_STYLE_PROMPT = [
  'Narrate this as a confident short-form story recap.',
  'Sound natural and conversational, with a clean, controlled delivery and real momentum.',
  'Use a brisk, energetic pace that moves quickly from point to point without rushing words together.',
  'Avoid theatrical pauses, exaggerated drama, upward inflections at the ends of statements, and drawn-out syllables.',
  'Keep pronunciation crisp and sentence endings decisive.',
].join(' ');
/**
 * Post-synthesis pitch-preserving speed factor. 1.0 = the clone's NATURAL read (no speed-up) — the
 * dominant lever for perceived pace. Earlier 1.2–1.25x on top of an already-fast anime-recap clone
 * read as too rushed (~276 WPM); 1.0 lands ~230 WPM. Raise it only if a slower speaker needs help.
 */
export const VIDEO_SUMMARY_NARRATION_TEMPO = 1.0;
/**
 * Written-word budget per FINISHED second — also a pace lever (density). At ~3.3 the script is less
 * crammed (fewer, longer beats), which reads calmer than the ~4.6 that packed 21 quick cuts to fill
 * the tier. The tradeoff is deliberate: a calmer read fills less of the 90s tier. Keep in step with
 * the service's NARRATION_WORDS_PER_SECOND.
 */
export const VIDEO_SUMMARY_WORDS_PER_SECOND = 3.8;

/**
 * Resolves the incoming voice id to a qwen3-tts voice. A known preset speaker name is used as-is
 * (custom_voice); anything else — including the legacy Gemini "Kore" — falls to the default preset.
 * A cloned voice ("clone:…") is surfaced by the job's own voice config, not here. Cloning support
 * (voice_clone with a hosted reference clip) rides the same NarrationVoice shape when a job carries
 * a reference URL.
 */
const QWEN_PRESET_SPEAKERS = new Set([
  'Aiden', 'Dylan', 'Eric', 'Ono_anna', 'Ryan', 'Serena', 'Sohee', 'Uncle_fu', 'Vivian',
]);
const DEFAULT_SUMMARY_SPEAKER = 'Serena';
function resolveSummaryVoice(voiceId: string): NarrationVoice {
  const speaker = QWEN_PRESET_SPEAKERS.has(voiceId) ? voiceId : DEFAULT_SUMMARY_SPEAKER;
  return {
    mode: 'custom_voice',
    speaker,
    styleInstruction: VIDEO_SUMMARY_VOICE_STYLE_PROMPT,
    language: 'English',
  };
}
/** Fixed gap between per-beat TTS calls, to stay under the native endpoint's burst rate limit. */
const NARRATION_INTER_STEM_DELAY_MS = 1_200;

const VIDEO_SUMMARY_MUSIC_DIRECTION = [
  'Use a dramatic cinematic instrumental underscore for a fast-paced story recap.',
  'Build tension with a steady pulse and restrained percussion.',
  'No vocals, lyrics, or melody that imitates an existing work.',
].join(' ');

/**
 * Framing this worker requests; must stay in step with buildSummarySizingFilter's own constant.
 * 'fill' keeps the picture full-bleed in the square window — 'balanced'/'fit' would show more of
 * each frame, but they letterbox inside the square, which raises the picture's lower edge and
 * forces the caption up with it.
 */
const SUMMARY_SOURCE_FRAMING = 'fill';
const SUMMARY_CAPTION_FONT_SIZE = 64;
const SUMMARY_CAPTION_OUTLINE_WIDTH = 3;
/**
 * Portrait layout: the 1:1 square rides a bit above center in the 9:16 canvas (top edge this many
 * px down), leaving a black band beneath it that holds the captions. Text in the black never fights
 * a bright or dark scene, and — once editability lands — this is where the repositionable caption
 * layer defaults to. 280px lifts a 1080 square to y=280..1360 (a gentle lift off the 420px center),
 * leaving a ~560px caption band below.
 */
export const SUMMARY_PORTRAIT_SQUARE_TOP_PX = 280;
/**
 * Caption block center, this many px BELOW the square's lower edge — sits high in the black band
 * (close under the footage) rather than floating in the middle of it, while staying clearly off the
 * video. At top=280 the square ends at y=1360, so 140 puts the caption center at y=1500.
 */
export const SUMMARY_CAPTION_BELOW_SQUARE_PX = 140;

/**
 * Vertical center anchor (0..1) for portrait summary captions, placed in the BLACK band just below
 * the (upward-biased) square rather than over the footage — high in the band, hugging the footage's
 * lower edge, so it reads as attached to the video while never overlapping it. Independent of
 * source framing/dimensions (the band is pure black). Non-portrait canvases (1:1, 16:9) have no
 * band and defer to the format preset (undefined).
 */
export function resolveSummaryCaptionAnchor(args: {
  canvas: { width: number; height: number };
  squareTopPx: number;
}): number | undefined {
  const { canvas, squareTopPx } = args;
  if (canvas.height <= canvas.width) return undefined;
  const squareBottom = squareTopPx + canvas.width;
  const anchor = squareBottom + SUMMARY_CAPTION_BELOW_SQUARE_PX;
  return Math.min(1, Math.max(0, anchor / canvas.height));
}

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Summary source download failed (${response.status})`);
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    createWriteStream(destPath),
  );
}

async function downloadBuffer(r2Key: string): Promise<Buffer> {
  const response = await fetch(await getGenerationPresignedUrl(r2Key));
  if (!response.ok) throw new Error(`Narration download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

function localizeWordsForSceneCues(
  narrations: string[],
  words: CaptionWordDraft[],
  sceneStartOffsets: number[],
): CaptionWordDraft[] {
  let cursor = 0;
  return narrations.flatMap((narration, sceneIndex) => {
    const count = narration.trim() ? narration.trim().split(/\s+/).length : 0;
    const offset = sceneStartOffsets[sceneIndex] ?? 0;
    const sceneWords = words.slice(cursor, cursor + count).map((word) => ({
      text: word.text,
      startSeconds: Math.max(0, word.startSeconds - offset),
      endSeconds: Math.max(0, word.endSeconds - offset),
    }));
    cursor += count;
    return sceneWords;
  });
}

/** Trim or safely extend selected ranges so every beat plays at natural 1x speed. */
export function allocateSummaryClipDurations(
  clips: VideoSummaryClip[],
  narrationDurationSeconds: number,
  sourceDurationSeconds?: number,
): SummarySourceClipSpec[] {
  const sourceTotal = clips.reduce((sum, clip) => sum + (clip.endSeconds - clip.startSeconds), 0);
  if (sourceTotal <= 0 || narrationDurationSeconds <= 0) throw new Error('Cannot time an empty summary beat');

  if (sourceTotal < narrationDurationSeconds) {
    if (sourceDurationSeconds === undefined) {
      throw new Error('Verified footage is shorter than the narration beat');
    }
    const extended = clips.map((clip) => ({ ...clip }));
    let remaining = narrationDurationSeconds - sourceTotal;
    const last = extended[extended.length - 1]!;
    const extendAfter = Math.min(remaining, Math.max(0, sourceDurationSeconds - last.endSeconds));
    last.endSeconds += extendAfter;
    remaining -= extendAfter;
    const first = extended[0]!;
    const extendBefore = Math.min(remaining, Math.max(0, first.startSeconds));
    first.startSeconds -= extendBefore;
    remaining -= extendBefore;
    if (remaining > 0.001) throw new Error('Verified footage is shorter than the narration beat');
    return extended.map((clip) => ({
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      outputDurationSeconds: clip.endSeconds - clip.startSeconds,
    }));
  }

  const keepRatio = narrationDurationSeconds / sourceTotal;
  let allocated = 0;
  return clips.map((clip, index) => {
    const sourceDuration = clip.endSeconds - clip.startSeconds;
    const keptDuration = index === clips.length - 1
      ? Math.max(0.1, narrationDurationSeconds - allocated)
      : narrationDurationSeconds * sourceDuration / sourceTotal;
    allocated += keptDuration;
    const trimEachSide = sourceDuration * (1 - keepRatio) / 2;
    const startSeconds = clip.startSeconds + trimEachSide;
    return {
      startSeconds,
      endSeconds: startSeconds + keptDuration,
      outputDurationSeconds: keptDuration,
    };
  });
}

export async function processVideoSummary(data: VideoSummaryJob): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), `video-summary-${data.generationId}-`));
  try {
    const started = await markProcessing(data.generationId);
    if (!started) return;

    const stampStage = (stageLabel: string) => (
      mergeGenerationParams(data.generationId, { stage_label: stageLabel }).catch(() => {})
    );
    const sourcePath = path.join(tempDir, 'source.mp4');
    await stampStage('Analyzing episode…');
    await downloadToFile(await getUploadPresignedUrl(data.sourceR2Key), sourcePath);

    const [actionWindows, subtitleText] = await Promise.all([
      analyzeActionWindows(sourcePath, data.sourceDurationSeconds),
      extractEmbeddedSubtitleText(sourcePath),
    ]);
    await stampStage('Planning the story…');
    const plan = await planVideoSummary({
      localVideoPath: sourcePath,
      mimeType: data.sourceMimeType,
      mode: data.mode,
      theme: data.theme,
      userContext: data.context,
      outputDurationSeconds: data.outputDurationSeconds,
      sourceDurationSeconds: data.sourceDurationSeconds,
      actionWindows,
      subtitleText,
    });

    const format = FORMATS_BY_ID.explainer;
    if (!format) throw new Error('Explainer voice configuration unavailable');
    const stems: NarrationStem[] = [];
    await stampStage('Recording narration…');
    for (let index = 0; index < plan.beats.length; index += 1) {
      // Space the per-beat TTS calls out. The native endpoint rate-limits under a tight burst, and
      // paying a small fixed gap up front is cheaper than absorbing the 429s + exponential backoff
      // that the retry would otherwise take (and far cheaper than falling through to Fal).
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, NARRATION_INTER_STEM_DELAY_MS));
      }
      stems.push(await generateNarrationForScene(
        plan.beats[index]!.narration,
        data.voiceId,
        format.tts_model,
        data.generationId,
        index,
        VIDEO_SUMMARY_VOICE_STYLE_PROMPT,
        VIDEO_SUMMARY_NARRATION_TEMPO,
        resolveSummaryVoice(data.voiceId),
      ));
    }

    const stemBuffers = await Promise.all(stems.map((stem) => downloadBuffer(stem.r2Key)));
    const narrationBuffer = concatWavBuffers(stemBuffers);
    const narrationR2Key = `generations/${data.generationId}.narration.wav`;
    await uploadBufferToR2(narrationBuffer, narrationR2Key, 'audio/wav');

    const sceneStartOffsets: number[] = [];
    let totalDuration = 0;
    for (const stem of stems) {
      sceneStartOffsets.push(totalDuration);
      totalDuration += stem.durationSeconds;
    }
    const narrations = plan.beats.map((beat) => beat.narration);
    const scriptWords = narrations.flatMap((line) => line.split(/\s+/).filter(Boolean));
    const globalWords = await getWordTimings(
      await getGenerationPresignedUrl(narrationR2Key),
      scriptWords,
      totalDuration,
    );
    const cues = buildSceneCues(
      narrations,
      localizeWordsForSceneCues(narrations, globalWords, sceneStartOffsets),
      sceneStartOffsets,
    );

    let musicR2Key: string | null = null;
    if (data.includeMusic) {
      await stampStage('Scoring…');
      musicR2Key = (await generateMusicBed(
        plan.musicMood,
        format.music_model,
        data.generationId,
        VIDEO_SUMMARY_MUSIC_DIRECTION,
      ))?.r2Key ?? null;
    }

    const clips = plan.beats.flatMap((beat, index) => (
      allocateSummaryClipDurations(beat.clips, stems[index]!.durationSeconds, data.sourceDurationSeconds)
    ));
    await mergeGenerationParams(data.generationId, {
      format_id: 'video-explainer',
      summary_mode: data.mode,
      summary_title: plan.title,
      summary_overview: plan.overview,
      plot_understanding: plan.plotUnderstanding ? {
        characters: plan.plotUnderstanding.characters,
        causal_summary: plan.plotUnderstanding.causalSummary,
        story_outline: plan.plotUnderstanding.storyOutline,
      } : null,
      source_knowledge: plan.sourceKnowledge ? {
        source: plan.sourceKnowledge.source,
        title: plan.sourceKnowledge.title,
        url: plan.sourceKnowledge.url,
        confidence: plan.sourceKnowledge.confidence,
      } : null,
      structured: {
        audioStems: [
          { r2Key: narrationR2Key, sourceType: 'narration' },
          ...(musicR2Key ? [{ r2Key: musicR2Key, sourceType: 'preset' }] : []),
        ],
        captionCues: cues.map((cue) => ({
          startSeconds: cue.startSeconds,
          endSeconds: cue.endSeconds,
          words: cue.words,
        })),
        videoClips: clips.map((clip) => ({
          sourceR2Key: data.sourceR2Key,
          trimStartSeconds: clip.startSeconds,
          trimEndSeconds: clip.endSeconds,
          outputDurationSeconds: clip.outputDurationSeconds,
          // Burned master drops footage audio (buildSummaryComposeArgs maps only narration+music),
          // so the rebuilt editable timeline starts footage-silent to match; user can raise it.
          sourceVolume: 0,
        })),
      },
    });

    const canvas = data.aspectRatio === '16:9'
      ? { width: 1920, height: 1080 }
      : data.aspectRatio === '1:1'
        ? { width: 1080, height: 1080 }
        : { width: 1080, height: 1920 };
    // Portrait lifts the square high and drops captions into the black band below it; other
    // aspect ratios have no band, keep the square centered, and leave captions to the preset.
    const squareTopPx = data.aspectRatio === '9:16' ? SUMMARY_PORTRAIT_SQUARE_TOP_PX : undefined;
    const captionYOffsetNorm = resolveSummaryCaptionAnchor({
      canvas,
      squareTopPx: squareTopPx ?? Math.round((canvas.height - canvas.width) / 2),
    });
    await stampStage('Rendering summary…');
    await ffmpegQueue.add('generate', {
      generationId: data.generationId,
      userId: data.userId,
      costCredits: data.cost,
      op: 'summary_compose',
      inputR2Keys: [data.sourceR2Key],
      mediaType: 'video',
      summaryCompose: {
        ...canvas,
        sourceFraming: SUMMARY_SOURCE_FRAMING,
        portraitSquareTopPx: squareTopPx,
        sourceR2Key: data.sourceR2Key,
        clips,
        narrationR2Key,
        musicR2Key,
        musicVolume: 0.18,
        captionCues: cues,
        captionStyle: {
          fontSize: SUMMARY_CAPTION_FONT_SIZE,
          color: format.caption_style.textColor,
          highlightColor: format.caption_style.highlightColor,
          position: format.caption_style.position,
          karaoke: false,
          outlineWidth: SUMMARY_CAPTION_OUTLINE_WIDTH,
          shadowDepth: 1.5,
          backgroundBox: false,
          yOffsetNorm: captionYOffsetNorm,
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[video-summary] pipeline failed for ${data.generationId}: ${message}`);
    await markFailed(data.generationId, classifyFailureReason(message));
    await refundCredits(data.userId, data.cost, `video-summary-failure-${data.generationId}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export const videoSummaryWorker = new Worker<VideoSummaryJob>(
  QUEUE_NAME,
  (job: Job<VideoSummaryJob>) => processVideoSummary(job.data),
  { connection: connectionOptions, concurrency: 1 },
);

videoSummaryWorker.on('failed', (job, err) => {
  console.error(`[video-summary] Job ${job?.id} failed unexpectedly:`, err);
});
