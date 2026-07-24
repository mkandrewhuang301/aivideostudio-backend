// src/services/providers/ReplicateProvider.ts
// CLAUDE.md Rule 6: provider abstraction — this is the ONLY file that imports the `replicate` package.
// CLAUDE.md Rule 7: durationSeconds must already be resolved (never -1) by the caller before dispatch().

import Replicate, { validateWebhook } from 'replicate';
import { config } from '../../config';
import { ModelProvider, GenerationInput, DispatchResult, PredictionStatus } from './ModelProvider';
import { archiveToR2 } from '../archivalService';

const replicate = new Replicate({ auth: config.replicateApiToken });
const WHISPERX_MODEL = 'victor-upmeet/whisperx:655845d6190ef70573c669245f245892cd039df4b880a1e3a65852c09252f5cc';

export interface WhisperXWord {
  word: string;
  start: number;
  end: number;
}

/**
 * Runs a Replicate call with bounded retry on HTTP 429 (throttling). Replicate drops the
 * prediction-creation limit to ~6/min while an account is under $5 credit, and a burst of narration
 * + WhisperX calls trips it; the throttle resets within ~1s, so a short backoff clears it without
 * failing the job. Honors the server's `retry_after` when present. Non-429 errors rethrow at once.
 */
const REPLICATE_429_ATTEMPTS = 5;
async function withReplicateRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REPLICATE_429_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      if (!/\b429\b|too many requests|throttl/i.test(msg) || attempt === REPLICATE_429_ATTEMPTS - 1) {
        throw error;
      }
      const retryAfter = Number(/retry_after"?\s*:?\s*(\d+)/i.exec(msg)?.[1]);
      const delayMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000;
      console.warn(`[replicate] ${label} throttled (429); retrying in ${delayMs}ms (attempt ${attempt + 1})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/** Keeps Replicate's SDK webhook verifier behind the same provider boundary as every SDK call. */
export async function validateReplicateWebhook(
  args: Parameters<typeof validateWebhook>[0],
): Promise<boolean> {
  return validateWebhook(args);
}

interface WhisperXOutput {
  segments?: Array<{
    words?: Array<{
      word?: unknown;
      start?: unknown;
      end?: unknown;
    }>;
  }>;
}

/**
 * Sync WhisperX dispatch over a presigned audio URL. The version pin and field names come from
 * the authenticated live schema captured by Plan 14-01.
 */
export async function transcribeWordTimings(audioUrl: string): Promise<WhisperXWord[]> {
  const output = (await withReplicateRetry(() => replicate.run(WHISPERX_MODEL, {
    input: {
      audio_file: audioUrl,
      align_output: true,
      language: 'en',
    },
  }), 'whisperx')) as unknown as WhisperXOutput;

  const words = Array.isArray(output?.segments)
    ? output.segments.flatMap((segment) => (
      Array.isArray(segment.words)
        ? segment.words.flatMap((word) => (
          typeof word.word === 'string'
          && typeof word.start === 'number'
          && Number.isFinite(word.start)
          && typeof word.end === 'number'
          && Number.isFinite(word.end)
            ? [{ word: word.word, start: word.start, end: word.end }]
            : []
        ))
        : []
    ))
    : [];

  if (words.length === 0) {
    throw new Error('whisperx returned no word timings');
  }
  return words;
}

// ─── qwen3-tts narration (single TTS engine, per 2026-07-23 TTS strategy) ──────
// Live schema verified 2026-07-23 (GET api.replicate.com/v1/models/qwen/qwen3-tts): output is a
// WAV URI (RIFF, audio/wav) so no transcode is needed downstream. One model, three modes:
// custom_voice (preset speakers: Aiden/Dylan/Eric/Ono_anna/Ryan/Serena/Sohee/Uncle_fu/Vivian),
// voice_clone (reference_audio URL + reference_text), voice_design (held). style_instruction is
// the natural-language delivery lever; timbre is fixed by the speaker/clone.

export type QwenTtsMode = 'custom_voice' | 'voice_clone';

export interface QwenTtsInput {
  text: string;
  mode: QwenTtsMode;
  /** custom_voice only — one of the preset speaker names. */
  speaker?: string;
  /** voice_clone only — a URL Replicate can fetch (e.g. a presigned R2 link to the reference clip). */
  referenceAudioUrl?: string;
  /** voice_clone only — transcript of the reference clip (strongly recommended; raw clones look worse). */
  referenceText?: string;
  /** Natural-language pace/emotion direction; timbre is unaffected. */
  styleInstruction?: string;
  /** Defaults to 'auto'. */
  language?: string;
}

const QWEN_TTS_MODEL = 'qwen/qwen3-tts';

/** Synthesizes one narration line to a WAV buffer via qwen3-tts. Throws on any failure so the
 *  caller can apply its own retry / provider-fallback policy. */
export async function replicateQwenTts(input: QwenTtsInput): Promise<Buffer> {
  const replicateInput: Record<string, unknown> = {
    text: input.text,
    mode: input.mode,
    language: input.language ?? 'auto',
  };
  if (input.styleInstruction) replicateInput.style_instruction = input.styleInstruction;
  if (input.mode === 'custom_voice') {
    replicateInput.speaker = input.speaker ?? 'Serena';
  } else {
    if (!input.referenceAudioUrl) throw new Error('qwen voice_clone requires referenceAudioUrl');
    replicateInput.reference_audio = input.referenceAudioUrl;
    if (input.referenceText) replicateInput.reference_text = input.referenceText;
  }

  const output = (await withReplicateRetry(
    () => replicate.run(QWEN_TTS_MODEL, { input: replicateInput }),
    'qwen3-tts',
  )) as unknown;
  const first = Array.isArray(output) ? output[0] : output;
  const url = typeof first === 'string'
    ? first
    : (first && typeof (first as { url?: unknown }).url === 'function')
      ? String((first as { url: () => unknown }).url())
      : '';
  if (!url) throw new Error('qwen3-tts returned no audio output');

  const response = await fetch(url);
  if (!response.ok) throw new Error(`qwen3-tts audio download failed (${response.status})`);
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw new Error('qwen3-tts returned an empty audio file');
  return audio;
}

// ─── Chained-job image stage: Wan 2.7 Image (09.6-05) ─────────────────────────
// Composes chain keyframe(s) (UVU's 2 cinematic stills — arena walk-in / spotlight reveal) from
// the user's own photo(s) + a server prompt. Composition is REQUIRED because HappyHorse animates
// a reference image IN PLACE — it does not transplant a subject into a new scene (R-03) — so the
// keyframe's background must already exist before HappyHorse ever sees it.
//
// This is the codebase's FIRST SYNCHRONOUS Replicate call (`replicate.run()`, blocks until the
// prediction completes and returns the output directly) — every other Replicate call in this file
// is async (`dispatch()` above uses `predictions.create` + webhook). That's intentional here: the
// chain worker (chainGenerationWorker.ts) needs the archived keyframe key back before it can
// dispatch Stage 2 (HappyHorse), and there's no separate webhook route for this one-off image call
// — mirrors the synchronous CALL SHAPE openaiImageService.ts's generateFaceswap already uses
// (await → archive → return key), just backed by `replicate.run()` instead of an OpenAI fetch.
//
// Live schema verified 2026-07-12 (curl https://api.replicate.com/v1/models/wan-video/wan-2.7-image):
//   Input.required: prompt (string, up to 5000 chars)
//   Input.optional: images (array<uri>, up to 9, default []) — the user photo(s) go here;
//                   size (enum incl '1K'/'2K'/custom dims, default '2K') — pinned to '1K' here
//                   (ample for a HappyHorse i2v reference frame, keeps the sync call fast);
//                   num_outputs (1-4, default 1) — always 1 (one keyframe per call)
//   Output: array of output image URIs (never base64) — archived via archiveToR2 below.
// Live pricing verified 2026-07-12 (replicate.com/wan-video/wan-2.7-image pricing table): $0.03
// per output image ("or around 33 images for $1") — see generationService.ts
// IMAGE_MODEL_COSTS['wan-video/wan-2.7-image']. Do NOT hardcode a prompt — always caller-supplied.
export async function generateKeyframeFromPhotos(
  userPhotoUrls: string[],
  prompt: string,
  outputKeyArg: string,
): Promise<string> {
  const output = (await replicate.run('wan-video/wan-2.7-image', {
    input: {
      prompt,
      images: userPhotoUrls,
      size: '1K',
      num_outputs: 1,
    },
  })) as unknown;
  const outputUrl = Array.isArray(output) ? output[0] : output;
  if (typeof outputUrl !== 'string' || !outputUrl) {
    throw new Error('wan-video/wan-2.7-image returned no output image');
  }
  return archiveToR2(outputUrl, outputKeyArg, 'image/png');
}

/**
 * Generates one synchronous gpt-image-2 scene candidate with Andrew's frozen style anchor.
 * Candidate generation is intentionally cheap and repeatable; the worker vision-picks one result
 * before making the single expensive Omni call for the scene.
 */
export async function generateStyledStill(
  visualPrompt: string,
  styleAnchorUrl: string,
  imageModel: string,
  outputKey: string,
): Promise<string> {
  const qualityByModel: Record<string, string> = {
    'openai/gpt-image-2-high': 'high',
    'openai/gpt-image-2-medium': 'medium',
    'openai/gpt-image-2-low': 'low',
    'openai/gpt-image-2': 'high',
  };
  const quality = qualityByModel[imageModel];
  if (!quality) throw new Error(`Unsupported styled-still model: ${imageModel}`);

  // STYLE-ONLY framing (2026-07-23): the anchor is passed as input_images purely to lock the ART
  // STYLE (palette, line weight, shape language, shading). Without this instruction gpt-image-2
  // treats the anchor as a COMPOSITION reference and reproduces its subjects/background/layout in
  // every scene — the "same lighthouse landscape over and over" bleed. This forces a fresh,
  // distinct composition per scene while keeping the style consistent.
  const styleLockedPrompt =
    'Use the attached reference image ONLY as an ART-STYLE guide: match its illustration style, '
    + 'color palette, line weight, shape language, and shading approach. Do NOT copy its composition, '
    + 'layout, subjects, background, or scenery — those must come entirely from the scene description '
    + 'below and depict a completely new, distinct scene.\n\nSCENE:\n'
    + visualPrompt;

  const output = (await replicate.run('openai/gpt-image-2', {
    input: {
      prompt: styleLockedPrompt,
      input_images: [styleAnchorUrl],
      aspect_ratio: '9:16',
      quality,
    },
  })) as unknown;
  // The replicate client (v1.x) returns FileOutput object(s) with a .url() method, not plain
  // URL strings — normalize both shapes (and arrays of either).
  const first = Array.isArray(output) ? output[0] : output;
  const outputUrl = typeof first === 'string'
    ? first
    : (first && typeof (first as { url?: unknown }).url === 'function')
      ? String((first as { url: () => unknown }).url())
      : '';
  if (!outputUrl) {
    throw new Error('openai/gpt-image-2 returned no output image');
  }
  return archiveToR2(outputUrl, outputKey, 'image/png');
}

export class ReplicateProvider implements ModelProvider {
  async dispatch(input: GenerationInput, webhookUrl: string): Promise<DispatchResult> {
    let replicateInput: Record<string, unknown>;
    // GPT Image 2 virtual IDs encode quality; resolve to the real Replicate model slug.
    const GPT_QUALITY: Record<string, string> = {
      'openai/gpt-image-2-high':   'high',
      'openai/gpt-image-2-medium': 'medium',
      'openai/gpt-image-2-low':    'low',
      'openai/gpt-image-2':        'high',
    };
    const replicateModel = input.model in GPT_QUALITY ? 'openai/gpt-image-2' : input.model;

    if (input.mediaType === 'image') {
      const isGptImage = input.model in GPT_QUALITY;
      const gptQuality = GPT_QUALITY[input.model] ?? input.imageQuality ?? 'high';
      replicateInput = {
        prompt: input.prompt,
        aspect_ratio: input.imageAspectRatio ?? '1:1',
        ...(isGptImage ? { quality: gptQuality } : {}),
        ...(input.referenceImages?.length
          ? { [isGptImage ? 'input_images' : 'image_input']: input.referenceImages }
          : {}),
      };
    } else if (input.mediaType === 'avatar') {
      // DreamActor M2.0: portrait image + driving video — no text prompt
      replicateInput = {
        image: input.avatarImage,
        video: input.avatarDrivingVideo,
        ...(input.cutFirstSecond !== undefined ? { cut_first_second: input.cutFirstSecond } : {}),
      };
    } else if (input.mediaType === 'character_replace') {
      // Wan 2.2 Animate Replace ("replace" mode, D-23): swaps the person in `video` with
      // `character_image`, keeping the video's own background/motion/lighting (a relighting
      // LoRA blends the character into the scene). Verified schema: required video +
      // character_image; resolution optional — pinned to '720' for consistent quality (D-22
      // no-picker precedent; 480p is a cheaper future tier, unused in v1).
      replicateInput = {
        video: input.characterReplaceVideo,
        character_image: input.characterReplaceImage,
        resolution: '720',
        // D-04: defaults true (ai-influencer's existing behavior — driver clip's own audio
        // survives); Marlon's mux-postprocess dispatch sets this false via prepareCost so the raw
        // clip is silent (clean Plan-01 silent master, re-muxed with the bundled default track).
        merge_audio: input.characterReplaceMergeAudio ?? true,
      };
    } else if (input.mediaType === 'upscale' && input.model === 'recraft-ai/recraft-crisp-upscale') {
      // Recraft Crisp Upscale (Enhancer — image path): single-field schema, the entire model
      // input is { image }. Distinct flat-cost image enhancer, not the per-second video upscaler.
      replicateInput = {
        image: input.upscalerInputImage,
      };
    } else if (input.mediaType === 'upscale') {
      // ByteDance Video Upscaler: input video + optional quality params
      // 'pro' tier is Replicate-allowlist-only; always 'standard' unless explicitly set
      replicateInput = {
        video: input.upscalerInputVideo,
        ...(input.upscalerTier ? { processing_type: input.upscalerTier } : {}),
        ...(input.upscalerScene ? { scene: input.upscalerScene } : {}),
        ...(input.upscalerTargetResolution ? { target_resolution: input.upscalerTargetResolution } : {}),
        ...(input.upscalerTargetFps ? { target_fps: input.upscalerTargetFps } : {}),
      };
    } else if (input.model === 'xai/grok-imagine-video-1.5') {
      // Image-to-video, mandatory single `image` field — no bracket-token references,
      // no generate_audio (Replicate schema has no audio toggle; always synchronized).
      replicateInput = {
        prompt: input.prompt,
        image: input.referenceImages?.[0],
        duration: input.durationSeconds,
        resolution: input.resolution,
        aspect_ratio: input.aspectRatio,
      };
    } else if (input.model === 'kwaivgi/kling-v3-motion-control') {
      // Kling v3 motion control — wired by AI Influencer Pro (influencerProWorker.ts, 3rd stage).
      // Live-verified schema (2026-07-12): required `image` (reference character image) + `video`
      // (reference driver video), `mode` enum std/pro (default 'pro' upstream; we always send it
      // explicitly here so callers control the tier), `character_orientation` enum image/video
      // (default 'image'; Pro tier always sends 'video' — the whole point is preserving the
      // ORIGINAL video's motion/duration, not the character image's), `prompt` (optional, default
      // ""), `keep_original_sound` (default true).
      replicateInput = {
        image: input.klingMotionImage,
        video: input.klingMotionVideo,
        mode: input.klingMotionMode ?? 'std',
        ...(input.klingMotionPrompt ? { prompt: input.klingMotionPrompt } : {}),
        character_orientation: input.klingMotionCharacterOrientation ?? 'image',
        keep_original_sound: input.klingMotionKeepOriginalSound ?? true,
      };
    } else if (input.model === 'alibaba/happyhorse-1.1') {
      // HappyHorse 1.1: text-to-video (empty images array) OR image-to-video (single first-frame
      // image). Uses an `images` array field (NOT Seedance's reference_images + [ImageN] tokens).
      // Native audio + lip-sync is baked in — no audio field exists, so none is sent.
      replicateInput = {
        prompt: input.prompt,
        images: input.referenceImages ?? [],
        duration: input.durationSeconds,
        resolution: input.resolution,
        aspect_ratio: input.aspectRatio,
      };
    } else {
      // Video model input (CLAUDE.md Rule 7: durationSeconds never -1)
      replicateInput = {
        prompt: input.prompt,
        duration: input.durationSeconds,
        resolution: input.resolution,
        aspect_ratio: input.aspectRatio,
        generate_audio: input.audioEnabled,
      };
      if (input.referenceImages?.length) replicateInput.reference_images = input.referenceImages;
      if (input.referenceVideos?.length) replicateInput.reference_videos = input.referenceVideos;
    }

    const prediction = await replicate.predictions.create({
      model: replicateModel as `${string}/${string}`,
      input: replicateInput,
      webhook: webhookUrl,
      webhook_events_filter: ['completed'],
    });
    return { providerPredictionId: prediction.id };
  }

  async getStatus(providerPredictionId: string): Promise<PredictionStatus> {
    const prediction = await replicate.predictions.get(providerPredictionId);
    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    return {
      status: prediction.status as PredictionStatus['status'],
      outputUrl,
      error: prediction.error ? String(prediction.error) : undefined,
    };
  }
}
