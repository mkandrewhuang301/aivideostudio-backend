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
import { config } from '../config';
import { FORMATS_BY_ID } from '../config/formats';
import { getUploadPresignedUrl, getGenerationPresignedUrl, uploadBufferToR2 } from '../services/archivalService';
import { refundCredits } from '../services/creditService';
import {
  generateNarrationForScene,
  VOICE_A_REFERENCE_R2_KEY,
  VOICE_A_TRANSCRIPT,
  VIDEO_SUMMARY_VOICE_STYLE_PROMPT,
  type NarrationStem,
  type NarrationVoice,
} from '../services/geminiTtsService';

// Re-exported so existing consumers (genVoicePreviews.ts) keep working — the single definition
// lives in geminiTtsService, shared with the Explainer voice resolver.
export { VOICE_A_REFERENCE_R2_KEY, VOICE_A_TRANSCRIPT, VIDEO_SUMMARY_VOICE_STYLE_PROMPT };
import { generateMusicBed } from '../services/lyriaService';
import { probeHasAudioStream } from '../services/mediaProbe';
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
import { concatWavBuffers, silenceWav, wavDurationSeconds } from '../services/wavUtil';
import { buildSceneCues, getWordTimings } from '../services/whisperxService';
import type { CaptionWordDraft } from '../services/captionTranscriptionService';
import type { VideoSummaryJob } from './videoSummaryQueue';
import { ffmpegQueue, type SummaryDiegeticWindow, type SummarySourceClipSpec } from './ffmpegWorker';

const QUEUE_NAME = 'video-summary';
/**
 * Delivery direction. Deliberately asks for a BRISK read rather than the "clear, measured
 * conversational pace" this used to request — a slow open loses the feed before the story lands.
 * Pace is asked for once, here; the remaining lines still suppress the theatrical/drawn-out
 * failure modes that made an earlier speed attempt sound bad.
 */
/**
 * Post-synthesis pitch-preserving speed factor — VOICE-AWARE. The two summarizer voice paths read
 * at very different natural paces, so a single tempo can't serve both:
 *  - Google preset voices (Kore etc.) read SLOW → speed them up to a brisk recap pace (~1.2x). This
 *    is the same band-aid the presets always needed on Google TTS.
 *  - The qwen CLONE (Voice A) inherits its reference clip's already-fast pace (~237 WPM at 1.0x);
 *    stacking 1.2x on top overshoots (~276 WPM = too rushed), so the clone stays at 1.0x.
 */
export const VIDEO_SUMMARY_NARRATION_TEMPO_PRESET = 1.2;
export const VIDEO_SUMMARY_NARRATION_TEMPO_CLONE = 1.0;
/** @deprecated Clone-calibrated value kept for existing consumers; prefer the voice-aware pair. */
export const VIDEO_SUMMARY_NARRATION_TEMPO = VIDEO_SUMMARY_NARRATION_TEMPO_CLONE;
/**
 * Written-word budget per FINISHED second — also a pace lever (density). At ~3.3 the script is less
 * crammed (fewer, longer beats), which reads calmer than the ~4.6 that packed 21 quick cuts to fill
 * the tier. The tradeoff is deliberate: a calmer read fills less of the 90s tier. Keep in step with
 * the service's NARRATION_WORDS_PER_SECOND.
 */
export const VIDEO_SUMMARY_WORDS_PER_SECOND = 3.8;

/**
 * Resolves the incoming voice id to a qwen3-tts voice, or `undefined` when the id should render
 * on Google TTS instead. 'voiceA' is intercepted FIRST and always renders through voice_clone (a
 * presigned reference clip + transcript — the constants live in geminiTtsService, shared with the
 * Explainer resolver) — it is the only summarizer voice on qwen. Every other (preset) voice id
 * returns `undefined`, which sends generateNarrationForScene down its Google TTS path with
 * `voiceName` = the raw voiceId (a Chirp3-HD name like "Kore") — the qwen preset speakers gave the
 * presets a strong Chinese accent, so they were moved back to Google. Async because the clone path
 * needs to presign the reference clip's R2 key.
 */
async function resolveSummaryVoice(voiceId: string): Promise<NarrationVoice | undefined> {
  if (voiceId === 'voiceA') {
    return {
      mode: 'voice_clone',
      referenceAudioUrl: await getUploadPresignedUrl(VOICE_A_REFERENCE_R2_KEY),
      referenceText: VOICE_A_TRANSCRIPT,
      styleInstruction: VIDEO_SUMMARY_VOICE_STYLE_PROMPT,
      language: 'English',
    };
  }
  return undefined;
}
/** Fixed gap between per-beat TTS calls, to stay under the native endpoint's burst rate limit. */
const NARRATION_INTER_STEM_DELAY_MS = 1_200;

// "Let the clip breathe" diegetic-audio beat (2026-07-25 spec) ----------------------------------
/** Floor/ceiling for a diegetic beat's natural-speed highlight length D_i. */
const MIN_DIEGETIC_HIGHLIGHT_SECONDS = 3;
const MAX_DIEGETIC_HIGHLIGHT_SECONDS = 6;

/**
 * D_i — a diegetic beat's natural highlight duration: the sum of its (raw, unallocated) source
 * clip durations, clamped to [MIN_DIEGETIC_HIGHLIGHT_SECONDS, MAX_DIEGETIC_HIGHLIGHT_SECONDS].
 * This REPLACES "size footage to narration length" for that one beat — the clip plays at natural
 * 1x for a bounded highlight instead. Its silence stem is built to exactly this length (see
 * buildDiegeticSilenceStem), so allocateSummaryClipDurations below needs no special-casing at
 * all: it just targets the stem's own (measured) duration like every other beat.
 */
export function diegeticHighlightSeconds(clips: VideoSummaryClip[]): number {
  const totalSeconds = clips.reduce((sum, clip) => sum + (clip.endSeconds - clip.startSeconds), 0);
  return Math.min(MAX_DIEGETIC_HIGHLIGHT_SECONDS, Math.max(MIN_DIEGETIC_HIGHLIGHT_SECONDS, totalSeconds));
}

/**
 * A diegetic beat gets NO TTS — its "stem" is a silence WAV of length D_i, uploaded to R2 exactly
 * like a real narration stem so concatWavBuffers (format-strict) still yields one continuous
 * narration track with a silent gap where the diegetic clip's original audio plays instead.
 */
async function buildDiegeticSilenceStem(
  generationId: string,
  beatIndex: number,
  clips: VideoSummaryClip[],
): Promise<NarrationStem> {
  const buffer = silenceWav(diegeticHighlightSeconds(clips));
  const r2Key = `generations/${generationId}.narration.${beatIndex}.silence.wav`;
  await uploadBufferToR2(buffer, r2Key, 'audio/wav');
  return { r2Key, durationSeconds: wavDurationSeconds(buffer) };
}

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
 * video. At top=280 the square ends at y=1360, so 100 puts the caption center at y=1460 — a modest
 * lift toward the footage (was 140/y=1500) that still leaves a clear gap below the square for
 * multi-line captions so text never overlaps the video.
 */
export const SUMMARY_CAPTION_BELOW_SQUARE_PX = 100;

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

    const [actionWindows, subtitleText, sourceHasAudio] = await Promise.all([
      analyzeActionWindows(sourcePath, data.sourceDurationSeconds),
      extractEmbeddedSubtitleText(sourcePath),
      // "Let the clip breathe" no-audio-source fallback (2026-07-25 spec): a diegetic beat needs
      // real footage audio to carry — probed once, up front, off the same downloaded source file.
      probeHasAudioStream(sourcePath),
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
    // Defense-in-depth belt #2 (belt #1 is validateGroundedNarration ignoring audio_mode outright
    // while the flag is off): even if a beat somehow carries audio_mode: 'diegetic', it is only
    // ever treated as diegetic here when the feature is enabled AND the source actually has audio
    // to lift from — never a bare `plan.beats[i].audioMode === 'diegetic'` check.
    const diegeticEnabled = config.videoSummaryDiegeticEnabled && sourceHasAudio;

    const format = FORMATS_BY_ID.explainer;
    if (!format) throw new Error('Explainer voice configuration unavailable');
    // Resolved once — not per beat — since it's the same voice for every stem and the voiceA
    // branch presigns a reference URL (no need to re-presign per beat).
    const voice = await resolveSummaryVoice(data.voiceId);
    // Voice-aware pace: the qwen clone (voiceA) is already fast at 1.0x; Google presets read slow
    // and need the ~1.2x speed-up to hit the same brisk recap pace.
    const narrationTempo = data.voiceId === 'voiceA'
      ? VIDEO_SUMMARY_NARRATION_TEMPO_CLONE
      : VIDEO_SUMMARY_NARRATION_TEMPO_PRESET;
    const stems: NarrationStem[] = [];
    const beatIsDiegetic = plan.beats.map((beat) => diegeticEnabled && beat.audioMode === 'diegetic');
    await stampStage('Recording narration…');
    for (let index = 0; index < plan.beats.length; index += 1) {
      if (beatIsDiegetic[index]) {
        // No TTS for a diegetic beat — its stem is silence, sized to its natural highlight D_i.
        stems.push(await buildDiegeticSilenceStem(data.generationId, index, plan.beats[index]!.clips));
        continue;
      }
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
        narrationTempo,
        voice,
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

    // Per-beat clip specs (still in beat order) so a diegetic beat's underlying clips can be
    // threaded into diegeticWindows below — allocateSummaryClipDurations needs no diegetic
    // special-casing at all: the silence stem built above already measures D_i, so it targets
    // exactly like any other beat's stem duration.
    const beatClipSpecs = plan.beats.map((beat, index) => (
      allocateSummaryClipDurations(beat.clips, stems[index]!.durationSeconds, data.sourceDurationSeconds)
    ));
    const clips = beatClipSpecs.flat();

    let diegeticOutputCursor = 0;
    const diegeticWindows: SummaryDiegeticWindow[] = [];
    beatClipSpecs.forEach((clipSpecs, beatIndex) => {
      for (const clip of clipSpecs) {
        if (beatIsDiegetic[beatIndex]) {
          diegeticWindows.push({
            startSec: diegeticOutputCursor,
            endSec: diegeticOutputCursor + clip.outputDurationSeconds,
            sourceClipStartSec: clip.startSeconds,
            sourceClipEndSec: clip.endSeconds,
          });
        }
        diegeticOutputCursor += clip.outputDurationSeconds;
      }
    });

    // Surface WHICH moment the planner chose to "let breathe" (beat index, the source-time span its
    // audio plays from, and the model's reason) so the diegetic pick is inspectable — never random.
    const diegeticBeatIndex = beatIsDiegetic.findIndex(Boolean);
    const diegeticSelection = diegeticWindows.length > 0 && diegeticBeatIndex >= 0
      ? {
        beat_index: diegeticBeatIndex,
        reason: plan.beats[diegeticBeatIndex]!.audioModeReason ?? null,
        source_start_seconds: Math.min(...diegeticWindows.map((w) => w.sourceClipStartSec)),
        source_end_seconds: Math.max(...diegeticWindows.map((w) => w.sourceClipEndSec)),
        output_start_seconds: Math.min(...diegeticWindows.map((w) => w.startSec)),
        output_end_seconds: Math.max(...diegeticWindows.map((w) => w.endSec)),
      }
      : null;
    if (diegeticSelection) {
      console.log(
        `[video-summary] diegetic beat #${diegeticSelection.beat_index}: source `
        + `${diegeticSelection.source_start_seconds.toFixed(1)}-${diegeticSelection.source_end_seconds.toFixed(1)}s`
        + ` — ${diegeticSelection.reason ?? '(no reason given)'}`,
      );
    }

    await mergeGenerationParams(data.generationId, {
      format_id: 'video-explainer',
      diegetic_selection: diegeticSelection,
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
        // Absent when empty (the overwhelmingly common, flag-off case) so the compose job payload
        // is unchanged from before this feature existed — buildSummaryComposeArgs treats an absent
        // and an empty array identically anyway, but this keeps queued payloads minimal too.
        ...(diegeticWindows.length > 0 ? { diegeticWindows } : {}),
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
