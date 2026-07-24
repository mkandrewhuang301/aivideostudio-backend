import { config } from '../../config';

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
const TTS_TIMEOUT_MS = 90_000;
const LYRIA_TIMEOUT_MS = 120_000;
const MAX_TTS_BYTES = 32 * 1024 * 1024;
const MAX_MUSIC_BYTES = 16 * 1024 * 1024;

export interface GoogleAudioResult {
  audio: Buffer;
  mimeType: string;
  sampleRate?: number;
  channels?: number;
}

interface AudioBlock {
  data: string;
  mime_type?: unknown;
  mimeType?: unknown;
  sample_rate?: unknown;
  sampleRate?: unknown;
  channels?: unknown;
}

export class SafeGoogleAudioError extends Error {
  /** HTTP status when the failure came from the interactions endpoint; undefined otherwise. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

function finitePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isAudioBlock(value: unknown, allowUntyped: boolean): value is AudioBlock {
  if (!value || typeof value !== 'object') return false;
  const block = value as Record<string, unknown>;
  return typeof block.data === 'string'
    && block.data.length > 0
    && (allowUntyped || block.type === 'audio');
}

function findTypedAudioBlock(value: unknown, seen = new Set<object>()): AudioBlock | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (isAudioBlock(value, false)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTypedAudioBlock(item, seen);
      if (found) return found;
    }
    return undefined;
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findTypedAudioBlock(child, seen);
    if (found) return found;
  }
  return undefined;
}

/** Handles both the REST `output_audio` convenience property and audio blocks nested in steps. */
export function extractGoogleAudio(
  response: unknown,
  defaultMimeType: string,
  maxBytes: number,
): GoogleAudioResult {
  if (!response || typeof response !== 'object') {
    throw new SafeGoogleAudioError('Google audio failed (missing output)');
  }
  const envelope = response as Record<string, unknown>;
  const direct = isAudioBlock(envelope.output_audio, true) ? envelope.output_audio : undefined;
  const block = direct ?? findTypedAudioBlock(response);
  if (!block) throw new SafeGoogleAudioError('Google audio failed (missing output)');

  const encoded = block.data.replace(/\s/g, '');
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new SafeGoogleAudioError('Google audio failed (invalid output)');
  }
  if (encoded.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new SafeGoogleAudioError('Google audio failed (invalid output size)');
  }
  const audio = Buffer.from(encoded, 'base64');
  if (audio.length === 0 || audio.length > maxBytes) {
    throw new SafeGoogleAudioError('Google audio failed (invalid output size)');
  }

  const rawMime = block.mime_type ?? block.mimeType;
  return {
    audio,
    mimeType: typeof rawMime === 'string' && rawMime.trim() ? rawMime.trim().toLowerCase() : defaultMimeType,
    sampleRate: finitePositiveInteger(block.sample_rate ?? block.sampleRate),
    channels: finitePositiveInteger(block.channels),
  };
}

async function createAudioInteraction(
  label: 'TTS' | 'Lyria',
  body: Record<string, unknown>,
  defaultMimeType: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<GoogleAudioResult> {
  if (!config.geminiApiKey) throw new SafeGoogleAudioError(`Google ${label} failed (not configured)`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(INTERACTIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.geminiApiKey,
        'Api-Revision': API_REVISION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new SafeGoogleAudioError(`Google ${label} failed (${response.status})`, response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SafeGoogleAudioError(`Google ${label} failed (invalid response)`);
    }
    try {
      return extractGoogleAudio(payload, defaultMimeType, maxBytes);
    } catch (error) {
      if (error instanceof SafeGoogleAudioError) {
        throw new SafeGoogleAudioError(error.message.replace('Google audio', `Google ${label}`));
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof SafeGoogleAudioError) throw error;
    throw new SafeGoogleAudioError(`Google ${label} failed (unknown)`);
  } finally {
    clearTimeout(timer);
  }
}

export async function googleRunTts(
  modelId: string,
  prompt: string,
  voiceName: string,
): Promise<GoogleAudioResult> {
  return createAudioInteraction('TTS', {
    model: modelId,
    input: prompt,
    response_format: { type: 'audio' },
    generation_config: {
      speech_config: [{ voice: voiceName }],
    },
  }, 'audio/l16', MAX_TTS_BYTES, TTS_TIMEOUT_MS);
}

export async function googleRunLyria(modelId: string, prompt: string): Promise<GoogleAudioResult> {
  return createAudioInteraction('Lyria', {
    model: modelId,
    input: prompt,
  }, 'audio/mpeg', MAX_MUSIC_BYTES, LYRIA_TIMEOUT_MS);
}
