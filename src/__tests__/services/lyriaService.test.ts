jest.mock('../../config', () => ({
  config: {
    r2AccountId: 'mock',
    r2AccessKeyId: 'mock',
    r2SecretAccessKey: 'mock',
    r2BucketName: 'test-bucket',
    googleNativeAudioEnabled: true,
    googleAudioFalFallbackEnabled: true,
    falLyriaFallbackModel: 'fal-ai/lyria2',
  },
}));

const mockFalRunLyria = jest.fn();
jest.mock('../../services/providers/FalProvider', () => ({
  falRunLyria: mockFalRunLyria,
}));

const mockGoogleRunLyria = jest.fn();
jest.mock('../../services/providers/GoogleAudioProvider', () => ({
  googleRunLyria: mockGoogleRunLyria,
}));

const mockUploadBufferToR2 = jest.fn();
jest.mock('../../services/archivalService', () => ({
  uploadBufferToR2: mockUploadBufferToR2,
}));

import { generateMusicBed } from '../../services/lyriaService';

describe('generateMusicBed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFalRunLyria.mockResolvedValue('https://fal.media/music.wav');
    mockGoogleRunLyria.mockResolvedValue({
      audio: Buffer.from('native-mp3'),
      mimeType: 'audio/mpeg',
    });
    mockUploadBufferToR2.mockResolvedValue(undefined);
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from([82, 73, 70, 70]).buffer,
    });
  });

  it("returns null for 'none' without calling the provider or downloading media", async () => {
    await expect(generateMusicBed('none', 'registry/lyria-model', 'gen-1')).resolves.toBeNull();

    expect(mockFalRunLyria).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockUploadBufferToR2).not.toHaveBeenCalled();
  });

  it('requests an instrumental bed, archives it, and returns its R2 key', async () => {
    await expect(generateMusicBed('ambient', 'registry/lyria-model', 'gen-123'))
      .resolves.toEqual({ r2Key: 'generations/gen-123.music.wav' });

    expect(mockFalRunLyria).toHaveBeenCalledWith('registry/lyria-model', {
      prompt: expect.stringMatching(/ambient.*instrumental/i),
      negative_prompt: expect.stringMatching(/vocals/i),
    });
    expect(mockUploadBufferToR2).toHaveBeenCalledWith(
      expect.any(Buffer),
      'generations/gen-123.music.wav',
      'audio/wav',
    );
  });

  it('uses native Lyria billing and archives the returned MP3', async () => {
    await expect(generateMusicBed(
      'ambient',
      'lyria-3-clip-preview',
      'gen-native',
      'Use restrained percussion beneath the narration.',
    ))
      .resolves.toEqual({ r2Key: 'generations/gen-native.music.mp3' });

    expect(mockGoogleRunLyria).toHaveBeenCalledWith(
      'lyria-3-clip-preview',
      expect.stringMatching(/ambient.*instrumental.*restrained percussion/i),
    );
    expect(mockFalRunLyria).not.toHaveBeenCalled();
    expect(mockUploadBufferToR2).toHaveBeenCalledWith(
      Buffer.from('native-mp3'),
      'generations/gen-native.music.mp3',
      'audio/mpeg',
    );
  });

  it('falls back to Fal when native Lyria generation fails', async () => {
    mockGoogleRunLyria.mockRejectedValueOnce(new Error('native unavailable'));
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(generateMusicBed('dramatic', 'lyria-3-clip-preview', 'gen-fallback'))
      .resolves.toEqual({ r2Key: 'generations/gen-fallback.music.wav' });

    expect(mockFalRunLyria).toHaveBeenCalledWith('fal-ai/lyria2', expect.objectContaining({
      prompt: expect.stringMatching(/dramatic.*instrumental/i),
    }));
    warning.mockRestore();
  });

  it('throws a status-bearing error when the provider fails', async () => {
    mockFalRunLyria.mockRejectedValue(Object.assign(new Error('provider details'), { status: 503 }));

    await expect(generateMusicBed('dramatic', 'registry/lyria-model', 'gen-1'))
      .rejects.toThrow('Lyria music failed (503)');
    expect(mockUploadBufferToR2).not.toHaveBeenCalled();
  });
});
