const mockGoogleRunLyria = jest.fn();

jest.mock('../../services/providers/GoogleAudioProvider', () => {
  class SafeGoogleAudioError extends Error {
    constructor(message: string, readonly status?: number) {
      super(message);
    }
  }
  return {
    googleRunLyria: mockGoogleRunLyria,
    SafeGoogleAudioError,
  };
});

import {
  LyriaMusicProvider,
  MusicProviderError,
} from '../../services/providers/LyriaMusicProvider';
import { SafeGoogleAudioError } from '../../services/providers/GoogleAudioProvider';

describe('LyriaMusicProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the Gemini API adapter with the prompt and reference images', async () => {
    mockGoogleRunLyria.mockResolvedValue({
      audio: Buffer.from('music'),
      mimeType: 'audio/mpeg',
    });
    const references = [{ mimeType: 'image/jpeg' as const, data: Buffer.from('frame') }];

    await expect(new LyriaMusicProvider().generate({
      model: 'lyria-3-clip-preview',
      prompt: 'Instrumental score.',
      referenceImages: references,
    })).resolves.toEqual({
      audio: Buffer.from('music'),
      mimeType: 'audio/mpeg',
    });

    expect(mockGoogleRunLyria).toHaveBeenCalledWith(
      'lyria-3-clip-preview',
      'Instrumental score.',
      references,
    );
  });

  it.each([
    [429, true, 'rate_limited'],
    [503, true, 'provider_error'],
    [400, false, 'safety_rejected'],
    [403, false, 'provider_error'],
  ])('maps Google HTTP %i to retryable=%s and code=%s', async (status, retryable, code) => {
    mockGoogleRunLyria.mockRejectedValue(new SafeGoogleAudioError(`Google Lyria failed (${status})`, status));

    await expect(new LyriaMusicProvider().generate({
      model: 'lyria-3-clip-preview',
      prompt: 'Instrumental score.',
      referenceImages: [],
    })).rejects.toMatchObject<Partial<MusicProviderError>>({ retryable, code });
  });

  it('rejects a non-MP3 provider response before archival', async () => {
    mockGoogleRunLyria.mockResolvedValue({
      audio: Buffer.from('wav'),
      mimeType: 'audio/wav',
    });

    await expect(new LyriaMusicProvider().generate({
      model: 'lyria-3-pro-preview',
      prompt: 'Instrumental score.',
      referenceImages: [],
    })).rejects.toMatchObject<Partial<MusicProviderError>>({
      retryable: false,
      code: 'invalid_output',
    });
  });
});
