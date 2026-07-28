// src/services/providers/FalSamAudioProvider.ts
// CLAUDE.md Rule 6: provider abstraction — this is the ONLY file that imports @fal-ai/client for
// audio separation (FalProvider.ts is the pre-existing, separate music/video fal integration).
//
// Backs the Editor's "Separate audio" tool via Meta SAM Audio (fal.ai), endpoint
// fal-ai/sam-audio/separate. Pins reranking_candidates:1 (the only documented cost multiplier —
// DECISIONS.md sketches/002-audio-separation §1) and output_format:'mp3' (default is 48kHz WAV,
// too big for R2). Output is TWO named file fields — { target, residual, duration } — unlike the
// single-field fal outputs FalProvider.ts's falSubscribeForUrl handles, so this file has its own
// two-field extraction helper.
//
// This provider returns raw Buffers only. It MUST NOT write DB rows or serve/persist a fal URL
// (CLAUDE.md Rule 2 — provider URLs expire); R2 archival is the caller's (queue worker's) job.

import { fal, ApiError } from '@fal-ai/client';

import type {
  AudioSeparationInput,
  AudioSeparationProvider,
  AudioSeparationResult,
} from './AudioSeparationProvider';

export class AudioSeparationProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(message);
  }
}

interface SamAudioOutput {
  target?: { url?: unknown };
  residual?: { url?: unknown };
  duration?: unknown;
}

function extractUrls(data: unknown): { targetUrl: string; residualUrl: string } {
  const output = data as SamAudioOutput | undefined;
  const targetUrl = output?.target?.url;
  const residualUrl = output?.residual?.url;
  if (typeof targetUrl !== 'string' || targetUrl.length === 0) {
    throw new AudioSeparationProviderError('Fal SAM Audio returned no target output', true, 'no_output');
  }
  if (typeof residualUrl !== 'string' || residualUrl.length === 0) {
    throw new AudioSeparationProviderError('Fal SAM Audio returned no residual output', true, 'no_output');
  }
  return { targetUrl, residualUrl };
}

function mapFalError(error: unknown): AudioSeparationProviderError {
  if (error instanceof AudioSeparationProviderError) return error;
  if (error instanceof ApiError) {
    // 4xx = the request itself was rejected (bad prompt/input) — not retryable.
    // 5xx/other = transient provider-side failure — retryable.
    const retryable = error.status >= 500 || error.status === 429;
    const code = retryable ? 'provider_unavailable' : 'provider_rejected';
    return new AudioSeparationProviderError(`Fal SAM Audio failed (${error.status})`, retryable, code);
  }
  return new AudioSeparationProviderError('Fal SAM Audio request failed', true, 'provider_unavailable');
}

async function fetchBuffer(url: string, label: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new AudioSeparationProviderError(
      `Failed to fetch Fal SAM Audio ${label} output (${response.status})`,
      true,
      'fetch_failed',
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export class FalSamAudioProvider implements AudioSeparationProvider {
  async separate(input: AudioSeparationInput): Promise<AudioSeparationResult> {
    let result: { data?: unknown; requestId?: string };
    try {
      result = await fal.subscribe(input.model, {
        input: {
          audio_url: input.audioUrl,
          prompt: input.prompt,
          reranking_candidates: 1,
          output_format: 'mp3',
        },
      });
    } catch (error) {
      throw mapFalError(error);
    }

    const { targetUrl, residualUrl } = extractUrls(result.data);

    // fal's schema names these fields target=isolated / residual=everything-else, but live
    // outputs (confirmed by ear 2026-07-27 on "background music" separations) ship the two
    // buffers swapped relative to those names: the `target` URL carries the residual mix and
    // the `residual` URL carries the isolated prompt stem. Crossing them here keeps our
    // AudioSeparationResult contract honest so attachSeparationStems labels/roles/enabled
    // ("Everything else" on, prompt stem off) land on the correct audio.
    const [falTargetField, falResidualField] = await Promise.all([
      fetchBuffer(targetUrl, 'target'),
      fetchBuffer(residualUrl, 'residual'),
    ]);

    return {
      target: falResidualField,
      residual: falTargetField,
      mimeType: 'audio/mpeg',
      providerRequestId: result.requestId,
    };
  }
}

export const falSamAudioProvider = new FalSamAudioProvider();
