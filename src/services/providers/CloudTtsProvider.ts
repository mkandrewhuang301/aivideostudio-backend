// Cloud Text-to-Speech (texttospeech.googleapis.com) — the GA, production-quota TTS path.
//
// Replaces the preview interactions endpoint whose AI-Studio key rate-limits (429) under the
// summary's back-to-back per-beat calls. Same Chirp3-HD voices (Kore, Zephyr, …), no allowlist,
// no preview quota. LINEAR16 REST output is a self-contained WAV (RIFF header included), so the
// returned bytes are directly usable wherever the old provider's WAV was.
//
// Auth, in order: CLOUD_TTS_API_KEY (simplest from Railway — a key restricted to this one API),
// else Application Default Credentials via google-auth-library (the attached service account on
// Cloud Run, or `gcloud auth application-default` locally). No downloadable key required.

import { GoogleAuth } from 'google-auth-library';
import { config } from '../../config';

const SYNTHESIZE_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const TTS_TIMEOUT_MS = 60_000;
const MAX_TTS_BYTES = 32 * 1024 * 1024;

export class CloudTtsError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

// Lazily constructed so a project without ADC configured (e.g. an API-key-only deployment) never
// pays the auth client's startup cost or fails at import time.
let auth: GoogleAuth | undefined;
async function adcAccessToken(): Promise<string> {
  auth ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const token = await auth.getAccessToken();
  if (!token) throw new CloudTtsError('Cloud TTS ADC returned no access token');
  return token;
}

/**
 * Resolves a voice into Cloud TTS's `{ languageCode, name }`. A bare Gemini voice name ("Kore")
 * maps onto the configured Chirp3-HD default's locale; an already-qualified name
 * ("en-US-Chirp3-HD-Kore", "de-DE-Chirp3-HD-Puck") is used verbatim so callers can override the
 * language. languageCode is always the name's leading `xx-YY`.
 */
export function resolveCloudTtsVoice(voiceName: string): { languageCode: string; name: string } {
  const trimmed = (voiceName || '').trim();
  const qualified = /^[a-z]{2}-[A-Z]{2}-/.test(trimmed);
  // A short name (no locale prefix) swaps into the configured default, preserving that default's
  // locale + Chirp3-HD family while honouring the requested speaker.
  const name = qualified
    ? trimmed
    : config.cloudTtsVoice.replace(/-[^-]+$/, `-${trimmed || 'Kore'}`);
  const languageCode = name.split('-').slice(0, 2).join('-');
  return { languageCode, name };
}

/**
 * Synthesizes `text` to a WAV buffer. `speakingRate` is Cloud TTS's native tempo control (1 =
 * normal, 1.25 = the summary's faster read) — pitch-preserving, so it replaces the post-hoc ffmpeg
 * `atempo` stretch for this provider.
 */
export async function cloudTtsSynthesize(
  text: string,
  voiceName: string,
  speakingRate = 1,
): Promise<Buffer> {
  const { languageCode, name } = resolveCloudTtsVoice(voiceName);
  const body = JSON.stringify({
    input: { text },
    voice: { languageCode, name },
    audioConfig: {
      audioEncoding: 'LINEAR16',
      speakingRate: Math.min(4, Math.max(0.25, speakingRate)),
    },
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let url = SYNTHESIZE_URL;
  if (config.cloudTtsApiKey) {
    url += `?key=${encodeURIComponent(config.cloudTtsApiKey)}`;
  } else {
    headers.Authorization = `Bearer ${await adcAccessToken()}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    if (!response.ok) {
      // Message body is Google's JSON error; surface its text but never the key/token.
      let detail = '';
      try {
        detail = ((await response.json()) as { error?: { message?: string } }).error?.message ?? '';
      } catch { /* non-JSON error body */ }
      throw new CloudTtsError(`Cloud TTS synthesize failed (${response.status})${detail ? `: ${detail}` : ''}`, response.status);
    }
    const payload = (await response.json()) as { audioContent?: string };
    if (!payload.audioContent) throw new CloudTtsError('Cloud TTS returned no audioContent');
    const audio = Buffer.from(payload.audioContent, 'base64');
    if (audio.length === 0 || audio.length > MAX_TTS_BYTES) {
      throw new CloudTtsError(`Cloud TTS returned an invalid audio size (${audio.length} bytes)`);
    }
    return audio;
  } catch (error) {
    if (error instanceof CloudTtsError) throw error;
    // Abort (timeout) and network errors — retryable, mirror the interactions provider's shape.
    throw new CloudTtsError(error instanceof Error ? `Cloud TTS request failed: ${error.message}` : 'Cloud TTS request failed');
  } finally {
    clearTimeout(timer);
  }
}
