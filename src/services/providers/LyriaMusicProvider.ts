import type {
  MusicGenerationInput,
  MusicGenerationProvider,
  MusicGenerationResult,
} from './MusicGenerationProvider';
import { googleRunLyria, SafeGoogleAudioError } from './GoogleAudioProvider';

export class MusicProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(message);
  }
}

export class LyriaMusicProvider implements MusicGenerationProvider {
  async generate(input: MusicGenerationInput): Promise<MusicGenerationResult> {
    try {
      const generated = await googleRunLyria(input.model, input.prompt, input.referenceImages);
      if (generated.mimeType !== 'audio/mpeg' && generated.mimeType !== 'audio/mp3') {
        throw new MusicProviderError('Lyria returned unsupported audio', false, 'invalid_output');
      }
      return { audio: generated.audio, mimeType: 'audio/mpeg' };
    } catch (error) {
      if (error instanceof MusicProviderError) throw error;
      if (error instanceof SafeGoogleAudioError) {
        const status = error.status;
        const retryable = status === 429 || (status !== undefined && status >= 500);
        const code = status === 429
          ? 'rate_limited'
          : status === 400
            ? 'safety_rejected'
            : error.message.includes('not configured')
              ? 'not_configured'
              : error.message.includes('missing output') || error.message.includes('invalid output')
                ? 'invalid_output'
                : 'provider_error';
        throw new MusicProviderError(error.message, retryable, code);
      }
      throw new MusicProviderError('Lyria request failed', true, 'provider_error');
    }
  }
}
