jest.mock('../../config', () => ({
  config: {
    r2AccountId: 'mock',
    r2AccessKeyId: 'mock',
    r2SecretAccessKey: 'mock',
    r2BucketName: 'test-bucket',
    googleNativeAudioEnabled: true,
    googleAudioFalFallbackEnabled: true,
    falTtsFallbackModel: 'fal-ai/gemini-3.1-flash-tts',
  },
}));

const mockFalRunTts = jest.fn();
jest.mock('../../services/providers/FalProvider', () => ({
  falRunTts: mockFalRunTts,
}));

const mockGoogleRunTts = jest.fn();
jest.mock('../../services/providers/GoogleAudioProvider', () => ({
  googleRunTts: mockGoogleRunTts,
  // Real class so `instanceof` and `.status` work in the retry classifier under test.
  SafeGoogleAudioError: class SafeGoogleAudioError extends Error {
    status?: number;
    constructor(message: string, status?: number) { super(message); this.status = status; }
  },
}));

const mockUploadBufferToR2 = jest.fn();
jest.mock('../../services/archivalService', () => ({
  uploadBufferToR2: mockUploadBufferToR2,
}));

const mockProbeDurationSeconds = jest.fn();
jest.mock('../../services/mediaProbe', () => ({
  probeDurationSeconds: mockProbeDurationSeconds,
}));

import {
  generateNarrationForScene,
} from '../../services/geminiTtsService';
import { concatWavBuffers, wavDurationSeconds } from '../../services/wavUtil';

function makePcmWav(options: {
  durationSeconds: number;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
}): Buffer {
  const sampleRate = options.sampleRate ?? 8_000;
  const channels = options.channels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = Math.round(options.durationSeconds * sampleRate) * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

describe('wavUtil', () => {
  it('concatenates same-format WAVs and reports the sum of their durations', () => {
    const first = makePcmWav({ durationSeconds: 0.25 });
    const second = makePcmWav({ durationSeconds: 0.4 });

    const combined = concatWavBuffers([first, second]);

    expect(wavDurationSeconds(combined)).toBeCloseTo(0.65, 3);
  });

  it('rejects WAVs with mismatched audio formats', () => {
    const first = makePcmWav({ durationSeconds: 0.1, sampleRate: 8_000 });
    const second = makePcmWav({ durationSeconds: 0.1, sampleRate: 16_000 });

    expect(() => concatWavBuffers([first, second])).toThrow(/format/i);
  });
});

describe('generateNarrationForScene', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFalRunTts.mockResolvedValue('https://fal.media/narration.wav');
    mockGoogleRunTts.mockResolvedValue({
      audio: Buffer.from([0, 0, 1, 0]),
      mimeType: 'audio/l16',
      sampleRate: 24_000,
      channels: 1,
    });
    mockProbeDurationSeconds.mockResolvedValue(4.2);
    mockUploadBufferToR2.mockResolvedValue(undefined);
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from([82, 73, 70, 70]).buffer,
    });
  });

  it('archives the downloaded WAV and returns its measured duration', async () => {
    await expect(generateNarrationForScene(
      'A measured narration line.',
      'Kore',
      'registry/tts-model',
      'gen-123',
      2,
    )).resolves.toEqual({
      r2Key: 'generations/gen-123.narration.2.wav',
      durationSeconds: 4.2,
    });

    expect(mockUploadBufferToR2).toHaveBeenCalledTimes(1);
    expect(mockUploadBufferToR2).toHaveBeenCalledWith(
      expect.any(Buffer),
      'generations/gen-123.narration.2.wav',
      'audio/wav',
    );
    expect(mockProbeDurationSeconds).toHaveBeenCalledTimes(1);
  });

  it('forwards the configured model id and voice verbatim', async () => {
    await generateNarrationForScene('Hello', 'Zephyr', 'custom/tts-host', 'gen-1', 0);

    expect(mockFalRunTts).toHaveBeenCalledWith('custom/tts-host', {
      prompt: 'Hello',
      voice: 'Zephyr',
      output_format: 'wav',
    });
  });

  it('uses native Google billing and wraps raw PCM as WAV', async () => {
    await generateNarrationForScene(
      'Hello',
      'Kore',
      'gemini-3.1-flash-tts-preview',
      'gen-native',
      0,
    );

    expect(mockGoogleRunTts).toHaveBeenCalledWith(
      'gemini-3.1-flash-tts-preview',
      'Hello',
      'Kore',
    );
    expect(mockFalRunTts).not.toHaveBeenCalled();
    const uploaded = mockUploadBufferToR2.mock.calls[0]![0] as Buffer;
    expect(uploaded.toString('ascii', 0, 4)).toBe('RIFF');
    expect(uploaded.toString('ascii', 8, 12)).toBe('WAVE');
  });

  it('falls back to Fal only after native retries are exhausted', async () => {
    // Native is retried before the fallback, so a single blip must NOT reach Fal. Reject every
    // native attempt to trigger the fallback path. Fake timers so the exponential backoff between
    // attempts resolves instantly instead of waiting the real 2+4+8s.
    jest.useFakeTimers();
    try {
      mockGoogleRunTts.mockRejectedValue(new Error('native unavailable'));
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const promise = generateNarrationForScene(
        'Hello',
        'Kore',
        'gemini-3.1-flash-tts-preview',
        'gen-fallback',
        0,
      );
      await jest.runAllTimersAsync();
      await promise;

      // 4 native attempts before giving up on the native path.
      expect(mockGoogleRunTts).toHaveBeenCalledTimes(4);
      expect(mockFalRunTts).toHaveBeenCalledWith('fal-ai/gemini-3.1-flash-tts', {
        prompt: 'Hello',
        voice: 'Kore',
        output_format: 'wav',
      });
      warning.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers on a native retry without ever touching the fallback', async () => {
    jest.useFakeTimers();
    try {
      mockGoogleRunTts
        .mockRejectedValueOnce(new Error('transient blip'))
        .mockResolvedValueOnce({ audio: Buffer.from('wav-bytes'), mimeType: 'audio/wav' });
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const promise = generateNarrationForScene('Hello', 'Kore', 'gemini-3.1-flash-tts-preview', 'gen-retry', 0);
      await jest.runAllTimersAsync();
      await promise;

      expect(mockGoogleRunTts).toHaveBeenCalledTimes(2);
      expect(mockFalRunTts).not.toHaveBeenCalled();
      warning.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry a non-retryable native error (e.g. auth), failing over immediately', async () => {
    // A 401/403 is not transient — burning the retry budget on it just delays the inevitable.
    const { SafeGoogleAudioError } = jest.requireMock('../../services/providers/GoogleAudioProvider');
    mockGoogleRunTts.mockRejectedValue(new SafeGoogleAudioError('Google TTS failed (401)', 401));
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await generateNarrationForScene('Hello', 'Kore', 'gemini-3.1-flash-tts-preview', 'gen-auth', 0);

    expect(mockGoogleRunTts).toHaveBeenCalledTimes(1);
    expect(mockFalRunTts).toHaveBeenCalled();
    warning.mockRestore();
  });

  it('retries a 429 rate-limit before failing over', async () => {
    jest.useFakeTimers();
    try {
      const { SafeGoogleAudioError } = jest.requireMock('../../services/providers/GoogleAudioProvider');
      mockGoogleRunTts
        .mockRejectedValueOnce(new SafeGoogleAudioError('Google TTS failed (429)', 429))
        .mockResolvedValueOnce({ audio: Buffer.from([0, 0, 1, 0]), mimeType: 'audio/l16', sampleRate: 24_000, channels: 1 });
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const promise = generateNarrationForScene('Hello', 'Kore', 'gemini-3.1-flash-tts-preview', 'gen-429', 0);
      await jest.runAllTimersAsync();
      await promise;

      expect(mockGoogleRunTts).toHaveBeenCalledTimes(2);
      expect(mockFalRunTts).not.toHaveBeenCalled();
      warning.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('throws when the provider rejects or returns no audio URL', async () => {
    mockFalRunTts.mockRejectedValueOnce(new Error('provider failed'));
    await expect(generateNarrationForScene('Hello', 'Kore', 'model', 'gen-1', 0))
      .rejects.toThrow(/Gemini TTS failed/);

    mockFalRunTts.mockResolvedValueOnce(undefined);
    await expect(generateNarrationForScene('Hello', 'Kore', 'model', 'gen-1', 0))
      .rejects.toThrow(/Gemini TTS failed/);
  });

  it('throws when the downloaded stem cannot be measured', async () => {
    mockProbeDurationSeconds.mockResolvedValue(null);

    await expect(generateNarrationForScene('Hello', 'Kore', 'model', 'gen-1', 0))
      .rejects.toThrow(/duration/);
    expect(mockUploadBufferToR2).not.toHaveBeenCalled();
  });

  it('never exposes credential material from downstream errors', async () => {
    mockFalRunTts.mockRejectedValue(new Error('FAL_KEY=super-secret request body'));

    let thrown: unknown;
    try {
      await generateNarrationForScene('Hello', 'Kore', 'model', 'gen-1', 0);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/Gemini TTS failed/);
    expect((thrown as Error).message).not.toContain('super-secret');
    expect((thrown as Error).message).not.toContain('FAL_KEY');
  });
});
