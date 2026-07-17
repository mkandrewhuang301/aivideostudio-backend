jest.mock('../../config', () => ({
  config: {
    r2AccountId: 'mock',
    r2AccessKeyId: 'mock',
    r2SecretAccessKey: 'mock',
    r2BucketName: 'test-bucket',
  },
}));

const mockFalRunTts = jest.fn();
jest.mock('../../services/providers/FalProvider', () => ({
  falRunTts: mockFalRunTts,
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
