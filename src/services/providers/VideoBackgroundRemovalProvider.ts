// src/services/providers/VideoBackgroundRemovalProvider.ts
// CLAUDE.md Rule 6: the provider-agnostic contract for Studio's "Remove background" tool. Nothing
// outside the concrete implementation may know which vendor backs it.

/** Backgrounds Bria VRMBG 3.0 accepts. 'Transparent' is the alpha path; the rest are solid fills. */
export const BACKGROUND_COLORS = [
  'Transparent',
  'Black',
  'White',
  'Gray',
  'Red',
  'Green',
  'Blue',
  'Yellow',
  'Cyan',
  'Magenta',
  'Orange',
] as const;

export type BackgroundColor = (typeof BACKGROUND_COLORS)[number];

export function isBackgroundColor(value: unknown): value is BackgroundColor {
  return typeof value === 'string' && (BACKGROUND_COLORS as readonly string[]).includes(value);
}

export interface VideoBackgroundRemovalInput {
  /** config.videoBgRemovalModel = 'bria/video/background-removal/v3' */
  model: string;
  /** Presigned R2 URL of the source clip. */
  videoUrl: string;
  backgroundColor: BackgroundColor;
  /**
   * Container/codec to request. Resolved server-side by the service layer, NEVER by the client —
   * Bria's own default (webm_vp9) is unplayable on iOS AVPlayer.
   */
  outputContainerAndCodec: string;
  /** Keep the source audio in the output. */
  preserveAudio: boolean;
  /** Resolved explicit seconds (CLAUDE.md rule #7) — informational; Bria infers length itself. */
  durationSeconds: number;
}

export interface VideoBackgroundRemovalResult {
  /** Raw bytes of the processed video. Never a provider URL — those expire (rule #2). */
  video: Buffer;
  /** Reported by the provider; falls back to the container's conventional type. */
  mimeType: string;
  providerRequestId?: string;
}

export interface VideoBackgroundRemovalProvider {
  removeBackground(input: VideoBackgroundRemovalInput): Promise<VideoBackgroundRemovalResult>;
}
