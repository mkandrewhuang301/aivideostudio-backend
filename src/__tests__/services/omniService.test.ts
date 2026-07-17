jest.mock('../../config', () => ({
  config: {
    r2AccountId: 'mock',
    r2AccessKeyId: 'mock',
    r2SecretAccessKey: 'mock',
    r2BucketName: 'test-bucket',
  },
}));

const mockFalRunOmniI2v = jest.fn();
jest.mock('../../services/providers/FalProvider', () => ({
  falRunOmniI2v: mockFalRunOmniI2v,
}));

const mockUploadBufferToR2 = jest.fn();
jest.mock('../../services/archivalService', () => ({
  uploadBufferToR2: mockUploadBufferToR2,
}));

import { animateScene } from '../../services/omniService';

describe('animateScene', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFalRunOmniI2v.mockResolvedValue('https://fal.media/scene.mp4');
    mockUploadBufferToR2.mockResolvedValue(undefined);
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from([0, 0, 0, 24]).buffer,
    });
  });

  it.each([
    { narrationDuration: 2.4, providerDuration: 3 },
    { narrationDuration: 9.8, providerDuration: 10 },
  ])('clamps $narrationDuration seconds to $providerDuration and archives the clip', async ({
    narrationDuration,
    providerDuration,
  }) => {
    await expect(animateScene(
      'https://r2.example.com/winner.png',
      'gentle ambient motion',
      'registry/omni-model',
      '16:9',
      narrationDuration,
      'gen-123',
      4,
    )).resolves.toEqual({ r2Key: 'generations/gen-123.scene4.mp4' });

    expect(mockFalRunOmniI2v).toHaveBeenCalledWith('registry/omni-model', {
      prompt: 'gentle ambient motion',
      image_url: 'https://r2.example.com/winner.png',
      aspect_ratio: '16:9',
      duration: providerDuration,
    });
    expect(mockUploadBufferToR2).toHaveBeenCalledWith(
      expect.any(Buffer),
      'generations/gen-123.scene4.mp4',
      'video/mp4',
    );
  });

  it('throws on provider safety-filter failures without uploading a fallback', async () => {
    mockFalRunOmniI2v.mockRejectedValue(Object.assign(new Error('unsafe request body'), { status: 422 }));

    await expect(animateScene(
      'https://r2.example.com/winner.png',
      'motion',
      'model',
      '9:16',
      5,
      'gen-1',
      0,
    )).rejects.toThrow('Omni animation failed (422)');
    expect(mockUploadBufferToR2).not.toHaveBeenCalled();
  });
});
