import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config';
import { uploadBufferToR2 } from './archivalService';
import { probeDurationSeconds } from './mediaProbe';
import { falRunTts } from './providers/FalProvider';
import { googleRunTts, SafeGoogleAudioError } from './providers/GoogleAudioProvider';
import { cloudTtsSynthesize } from './providers/CloudTtsProvider';
import { replicateQwenTts } from './providers/ReplicateProvider';
import { pcm16ToWav } from './wavUtil';

/**
 * Per-format narration voice, resolved from server-driven config. Either a preset speaker
 * (custom_voice) or a cloned voice (voice_clone from a hosted reference clip). Timbre is fixed by
 * the speaker/clone; `styleInstruction` is the natural-language delivery lever.
 */
export interface NarrationVoice {
  mode: 'custom_voice' | 'voice_clone';
  speaker?: string;
  referenceAudioUrl?: string;
  referenceText?: string;
  styleInstruction?: string;
  language?: string;
}

const QWEN_TTS_ATTEMPTS = 3;
const QWEN_TTS_RETRY_DELAY_MS = 2_000;

const execFileAsync = promisify(execFile);
const TTS_DOWNLOAD_TIMEOUT_MS = 60_000;
const NATIVE_TTS_ATTEMPTS = 4;
const NATIVE_TTS_BASE_DELAY_MS = 2_000;
/** Statuses worth retrying: rate limiting and transient server errors. Auth/bad-request are not. */
const RETRYABLE_TTS_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Whether a native TTS failure is worth another attempt. Reads the status off SafeGoogleAudioError
 * when present; otherwise falls back to matching the code embedded in the message (the error text
 * is `Google TTS failed (429)` and similar), so this still works for errors that lost their type
 * crossing a boundary. Non-status errors (timeouts, aborts) are treated as retryable.
 */
function isRetryableTtsError(error: unknown): boolean {
  if (error instanceof SafeGoogleAudioError && typeof error.status === 'number') {
    return RETRYABLE_TTS_STATUSES.has(error.status);
  }
  if (error instanceof Error) {
    const match = error.message.match(/\((\d{3})\)/);
    if (match) return RETRYABLE_TTS_STATUSES.has(Number(match[1]));
    return true;
  }
  return true;
}

// B5 (Explainer Tiers, 2026-07-22): the validated voice lever is a natural-language STYLE PROMPT
// prepended into the SAME prompt field as the spoken text (NOT numeric stability/style knobs —
// see [[project_explainer_voice_recipe]]). Scoped to the Explainer worker's call site (an
// optional `stylePrompt` param below) rather than hardcoded into this function, since
// generateNarrationForScene is shared with Video Summarizer, whose narration should NOT take on
// an "explainer explaining a concept" delivery.
export const EXPLAINER_VOICE_STYLE_PROMPT = 'Speak in a voice like an explainer, explaining a concept.';

export interface NarrationStem {
  r2Key: string;
  durationSeconds: number;
}

class SafeTtsError extends Error {}

function statusFrom(error: unknown): string {
  if (!error || typeof error !== 'object' || !('status' in error)) return 'unknown';
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' || typeof status === 'string' ? String(status) : 'unknown';
}

async function downloadTtsWav(audioUrl: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(audioUrl, { signal: controller.signal });
    if (!response.ok) throw new SafeTtsError(`Gemini TTS download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function isNativeGoogleTtsModel(modelId: string): boolean {
  return modelId.startsWith('gemini-') && modelId.includes('-tts');
}

async function generateFalTtsWav(
  modelId: string,
  prompt: string,
  voiceName: string,
): Promise<Buffer> {
  const audioUrl = await falRunTts(modelId, {
    prompt,
    voice: voiceName,
    output_format: 'wav',
  });
  if (typeof audioUrl !== 'string' || audioUrl.length === 0) {
    throw new SafeTtsError('Gemini TTS failed (missing output)');
  }
  return downloadTtsWav(audioUrl);
}

async function generateTtsWav(
  modelId: string,
  text: string,
  voiceName: string,
  stylePrompt?: string,
): Promise<Buffer> {
  // The Gemini/Fal path takes delivery direction as prepended prompt text; Cloud TTS does NOT
  // (Chirp3-HD would speak the instruction aloud), so it gets raw `text` and controls pace via
  // speakingRate instead. Keep both forms available here rather than pre-combining upstream.
  const prompt = stylePrompt ? `${stylePrompt} ${text}` : text;
  if (!isNativeGoogleTtsModel(modelId)) return generateFalTtsWav(modelId, prompt, voiceName);

  // Primary: Cloud Text-to-Speech — GA, production quota, no AI-Studio preview rate limit, same
  // Chirp3-HD voices. On any failure, fall through to the interactions/Fal chain below so a Cloud
  // TTS outage can't take the feature down.
  if (config.cloudTtsEnabled) {
    try {
      return await cloudTtsSynthesize(text, voiceName, 1);
    } catch (error) {
      console.warn(
        'Cloud TTS failed; falling back to interactions/Fal:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (config.googleNativeAudioEnabled) {
    let lastError: unknown;
    // A summary fires one TTS call per beat, back to back, and the native interactions endpoint
    // rate-limits (429) under that burst — a single scene's blip used to drop straight to Fal, and
    // if Fal is down (e.g. an exhausted balance) it wasted the whole expensive plan+verification
    // run. Retry with EXPONENTIAL backoff, not a fixed delay: a rate window needs real spacing to
    // clear, and backing one scene off also spaces out the scenes queued behind it. Non-retryable
    // failures (auth, malformed request) break out immediately rather than burning the budget.
    for (let attempt = 0; attempt < NATIVE_TTS_ATTEMPTS; attempt += 1) {
      try {
        const result = await googleRunTts(modelId, prompt, voiceName);
        if (result.mimeType.startsWith('audio/wav') || result.mimeType.startsWith('audio/x-wav')) {
          return result.audio;
        }
        if (
          result.mimeType.startsWith('audio/l16')
          || result.mimeType.startsWith('audio/pcm')
          || result.mimeType.startsWith('audio/raw')
        ) {
          return pcm16ToWav(result.audio, result.sampleRate ?? 24_000, result.channels ?? 1);
        }
        throw new SafeTtsError('Gemini TTS failed (unsupported native audio format)');
      } catch (error) {
        lastError = error;
        if (!isRetryableTtsError(error) || attempt === NATIVE_TTS_ATTEMPTS - 1) break;
        await new Promise((resolve) => setTimeout(resolve, NATIVE_TTS_BASE_DELAY_MS * 2 ** attempt));
      }
    }
    // Log the ACTUAL native error, not just "falling back" — otherwise a native outage is
    // invisible and every failure looks like a Fal problem.
    console.warn(
      `Native Google TTS failed after ${NATIVE_TTS_ATTEMPTS} attempts`
      + `${config.googleAudioFalFallbackEnabled ? '; using configured Fal fallback' : ''}:`,
      lastError instanceof Error ? lastError.message : lastError,
    );
    if (!config.googleAudioFalFallbackEnabled) throw lastError;
  }

  return generateFalTtsWav(config.falTtsFallbackModel, prompt, voiceName);
}

/**
 * Pitch-preserving time stretch via ffmpeg's `atempo`. Returns the input untouched when no
 * meaningful change is requested, so the common path stays a no-op with no extra subprocess.
 * `atempo` only accepts 0.5–2.0 per instance, which comfortably covers narration pacing.
 */
async function applyWavTempo(
  rendered: Buffer,
  inputPath: string,
  tempDir: string,
  sceneIndex: number,
  tempo?: number,
): Promise<Buffer> {
  if (tempo == null || !Number.isFinite(tempo) || Math.abs(tempo - 1) < 0.01) return rendered;
  const clamped = Math.min(2, Math.max(0.5, tempo));
  const outputPath = path.join(tempDir, `scene-${sceneIndex}.tempo.wav`);
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath, '-filter:a', `atempo=${clamped}`, outputPath,
    ]);
    return await readFile(outputPath);
  } catch (err) {
    // Narration at the original pace beats no narration at all — the run stays valid, just longer.
    console.warn(`[tts] atempo=${clamped} failed, using unstretched narration:`, err);
    return rendered;
  }
}

/**
 * qwen3-tts narration with a bounded retry, falling back to the Cloud-TTS/interactions/Fal chain
 * only as last-resort insurance (a different model — acceptable per the 2026-07-23 strategy since
 * we are not standing up fal-qwen today). Returns a WAV buffer.
 */
async function renderNarration(
  text: string,
  voice: NarrationVoice,
  modelId: string,
  voiceName: string,
  stylePrompt?: string,
): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < QWEN_TTS_ATTEMPTS; attempt += 1) {
    try {
      return await replicateQwenTts({
        text,
        mode: voice.mode,
        speaker: voice.speaker,
        referenceAudioUrl: voice.referenceAudioUrl,
        referenceText: voice.referenceText,
        styleInstruction: voice.styleInstruction ?? stylePrompt,
        language: voice.language,
      });
    } catch (error) {
      lastError = error;
      if (attempt < QWEN_TTS_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, QWEN_TTS_RETRY_DELAY_MS * 2 ** attempt));
      }
    }
  }
  console.warn(
    'qwen3-tts failed after retries; falling back to Cloud-TTS/interactions/Fal insurance:',
    lastError instanceof Error ? lastError.message : lastError,
  );
  return generateTtsWav(modelId, text, voiceName, stylePrompt);
}

export async function generateNarrationForScene(
  text: string,
  voiceName: string,
  modelId: string,
  generationId: string,
  sceneIndex: number,
  /** Optional natural-language delivery directive, prepended to `text` in the same prompt field. */
  stylePrompt?: string,
  /**
   * Optional post-synthesis playback rate (1 = untouched). This is a pitch-preserving time
   * stretch applied to the rendered audio — NOT an instruction telling the model to talk faster,
   * which degrades delivery (see [[project_explainer_voice_recipe]]). Duration is measured AFTER
   * the stretch so every downstream consumer (footage allocation, caption offsets, word timing)
   * sees the real length.
   */
  tempo?: number,
  /**
   * Optional qwen3-tts voice (preset speaker or clone). When present and qwen is enabled, narration
   * renders through qwen with the Cloud-TTS/interactions/Fal chain as last-resort insurance; when
   * absent, the old chain runs directly. `tempo` still applies post-synthesis regardless.
   */
  voice?: NarrationVoice,
): Promise<NarrationStem> {
  let tempDir: string | undefined;
  try {
    const rendered = voice && config.qwenTtsEnabled
      ? await renderNarration(text, voice, modelId, voiceName, stylePrompt)
      : await generateTtsWav(modelId, text, voiceName, stylePrompt);
    tempDir = await mkdtemp(path.join(tmpdir(), 'explainer-tts-'));
    const tempPath = path.join(tempDir, `scene-${sceneIndex}.wav`);
    await writeFile(tempPath, rendered);

    const audio = await applyWavTempo(rendered, tempPath, tempDir, sceneIndex, tempo);
    const durationSeconds = await probeDurationSeconds(
      audio === rendered ? tempPath : path.join(tempDir, `scene-${sceneIndex}.tempo.wav`),
    );
    if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new SafeTtsError('Gemini TTS duration could not be measured');
    }

    const r2Key = `generations/${generationId}.narration.${sceneIndex}.wav`;
    await uploadBufferToR2(audio, r2Key, 'audio/wav');
    return { r2Key, durationSeconds };
  } catch (error) {
    if (error instanceof SafeTtsError) throw error;
    throw new Error(`Gemini TTS failed (${statusFrom(error)})`);
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}
