jest.mock('../../config', () => ({
  config: {
    r2AccountId: 'mock',
    r2AccessKeyId: 'mock',
    r2SecretAccessKey: 'mock',
    r2BucketName: 'test-bucket',
  },
}));

const mockFalRunLyria = jest.fn();
jest.mock('../../services/providers/FalProvider', () => ({
  falRunLyria: mockFalRunLyria,
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

  it('throws a status-bearing error when the provider fails', async () => {
    mockFalRunLyria.mockRejectedValue(Object.assign(new Error('provider details'), { status: 503 }));

    await expect(generateMusicBed('dramatic', 'registry/lyria-model', 'gen-1'))
      .rejects.toThrow('Lyria music failed (503)');
    expect(mockUploadBufferToR2).not.toHaveBeenCalled();
  });
});
