// src/services/providers/FalBriaBackgroundRemovalProvider.ts
// CLAUDE.md Rule 6: this is the ONLY file that imports @fal-ai/client for video background
// removal. Backs Studio's "Remove background" tool via Bria VRMBG 3.0
// (bria/video/background-removal/v3, live schema verified 2026-07-30).
//
// Provider input (all four fields resolved by the service layer, never by a client):
//   video_url, background_color, output_container_and_codec, preserve_audio
//
// This provider returns a raw Buffer only. It MUST NOT write DB rows or persist/serve a fal URL
// (CLAUDE.md Rule 2 — provider URLs expire); R2 archival is the queue worker's job.

import { fal, ApiError } from '@fal-ai/client';

import type {
  VideoBackgroundRemovalInput,
  VideoBackgroundRemovalProvider,
  VideoBackgroundRemovalResult,
} from './VideoBackgroundRemovalProvider';

export class VideoBackgroundRemovalProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(message);
  }
}

interface BriaOutput {
  video?: { url?: unknown; content_type?: unknown };
}

function extractVideo(data: unknown): { url: string; contentType?: string } {
  const output = data as BriaOutput | undefined;
  const url = output?.video?.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new VideoBackgroundRemovalProviderError('Bria returned no video output', true, 'no_output');
  }
  const contentType = output?.video?.content_type;
  return { url, contentType: typeof contentType === 'string' ? contentType : undefined };
}

function mapFalError(error: unknown): VideoBackgroundRemovalProviderError {
  if (error instanceof VideoBackgroundRemovalProviderError) return error;
  if (error instanceof ApiError) {
    // 4xx = the request itself was rejected (unreadable/unsupported input) — not retryable.
    // 5xx and 429 = transient provider-side failure — retryable.
    const retryable = error.status >= 500 || error.status === 429;
    const code = retryable ? 'provider_unavailable' : 'provider_rejected';
    return new VideoBackgroundRemovalProviderError(
      `Bria background removal failed (${error.status})`,
      retryable,
      code,
    );
  }
  return new VideoBackgroundRemovalProviderError(
    'Bria background removal request failed',
    true,
    'provider_unavailable',
  );
}

export class FalBriaBackgroundRemovalProvider implements VideoBackgroundRemovalProvider {
  async removeBackground(input: VideoBackgroundRemovalInput): Promise<VideoBackgroundRemovalResult> {
    let result: { data?: unknown; requestId?: string };
    try {
      result = await fal.subscribe(input.model, {
        input: {
          video_url: input.videoUrl,
          background_color: input.backgroundColor,
          // Explicit on purpose: Bria defaults this to webm_vp9, which iOS AVPlayer cannot play.
          // The service layer derives a playable container from the requested background.
          output_container_and_codec: input.outputContainerAndCodec,
          preserve_audio: input.preserveAudio,
        },
      });
    } catch (error) {
      throw mapFalError(error);
    }

    const { url, contentType } = extractVideo(result.data);

    const response = await fetch(url);
    if (!response.ok) {
      throw new VideoBackgroundRemovalProviderError(
        `Failed to fetch Bria output (${response.status})`,
        true,
        'fetch_failed',
      );
    }
    const video = Buffer.from(await response.arrayBuffer());
    if (video.length === 0) {
      throw new VideoBackgroundRemovalProviderError('Bria output was empty', true, 'no_output');
    }

    return {
      video,
      mimeType: contentType ?? 'video/mp4',
      providerRequestId: result.requestId,
    };
  }
}

export const falBriaBackgroundRemovalProvider = new FalBriaBackgroundRemovalProvider();
