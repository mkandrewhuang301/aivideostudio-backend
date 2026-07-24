jest.mock('../../config', () => ({
  config: { geminiApiKey: 'test-google-key' },
}));

import {
  extractGoogleAudio,
  googleRunLyria,
  googleRunTts,
} from '../../services/providers/GoogleAudioProvider';

describe('GoogleAudioProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('extracts the output_audio convenience property', () => {
    const result = extractGoogleAudio({
      output_audio: {
        data: Buffer.from([1, 2, 3, 4]).toString('base64'),
        mime_type: 'audio/L16',
        sample_rate: 24_000,
        channels: 1,
      },
    }, 'audio/l16', 1024);

    expect(result).toEqual({
      audio: Buffer.from([1, 2, 3, 4]),
      mimeType: 'audio/l16',
      sampleRate: 24_000,
      channels: 1,
    });
  });

  it('finds an audio block nested in interaction steps', () => {
    const result = extractGoogleAudio({
      steps: [{ content: [{ type: 'audio', data: Buffer.from('mp3').toString('base64') }] }],
    }, 'audio/mpeg', 1024);

    expect(result.audio.toString()).toBe('mp3');
    expect(result.mimeType).toBe('audio/mpeg');
  });

  it('rejects oversized audio before decoding it', () => {
    expect(() => extractGoogleAudio({
      output_audio: { data: Buffer.alloc(128).toString('base64') },
    }, 'audio/mpeg', 16)).toThrow('invalid output size');
  });

  it('sends native Gemini TTS with the selected voice and current API revision', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output_audio: { data: Buffer.from([0, 0]).toString('base64') },
      }),
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

    await googleRunTts('gemini-3.1-flash-tts-preview', 'Tell the story.', 'Kore');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      expect.objectContaining({ method: 'POST' }),
    );
    const request = fetchMock.mock.calls[0]![1] as { headers: Record<string, string>; body: string };
    expect(request.headers['x-goog-api-key']).toBe('test-google-key');
    expect(request.headers['Api-Revision']).toBe('2026-05-20');
    expect(JSON.parse(request.body)).toEqual({
      model: 'gemini-3.1-flash-tts-preview',
      input: 'Tell the story.',
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Kore' }] },
    });
  });

  it('sends Lyria through the same native billing endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output_audio: { data: Buffer.from('music').toString('base64'), mime_type: 'audio/mpeg' },
      }),
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

    await googleRunLyria('lyria-3-clip-preview', 'Instrumental only.');

    const request = fetchMock.mock.calls[0]![1] as { body: string };
    expect(JSON.parse(request.body)).toEqual({
      model: 'lyria-3-clip-preview',
      input: 'Instrumental only.',
    });
  });

  it('returns a credential-safe error for provider failures', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'test-google-key leaked detail' } }),
    });

    await expect(googleRunTts('gemini-3.1-flash-tts-preview', 'Hello', 'Kore'))
      .rejects.toThrow('Google TTS failed (429)');
  });
});
