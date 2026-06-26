// src/__tests__/services/archivalService.test.ts
// Unit tests for archiveToR2 — fetches Replicate output and streams it to R2 as the
// FIRST side effect (CLAUDE.md Rule 2: Replicate output URLs expire).

jest.mock('../../config', () => ({
  config: {
    r2AccountId: 'mock',
    r2AccessKeyId: 'mock',
    r2SecretAccessKey: 'mock',
    r2BucketName: 'test-bucket',
  },
}));

jest.mock('../../storage/r2', () => ({
  r2: { send: jest.fn() },
  R2_BUCKET: 'test-bucket',
}));

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { archiveToR2 } from '../../services/archivalService';
import { r2 } from '../../storage/r2';

describe('archiveToR2', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('fetches the output URL and streams it to R2 under generations/{id}.mp4', async () => {
    const arrayBuffer = new TextEncoder().encode('fake-video-bytes').buffer;
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: {},
      arrayBuffer: jest.fn().mockResolvedValue(arrayBuffer),
    });

    const key = await archiveToR2('https://replicate.delivery/abc.mp4', 'gen-123');

    expect(global.fetch).toHaveBeenCalledWith('https://replicate.delivery/abc.mp4');
    expect(r2.send).toHaveBeenCalledTimes(1);
    const sentCommand = (r2.send as jest.Mock).mock.calls[0][0];
    expect(sentCommand).toBeInstanceOf(PutObjectCommand);
    expect(sentCommand.input.Key).toBe('generations/gen-123.mp4');
    expect(sentCommand.input.ContentType).toBe('video/mp4');
    expect(key).toBe('generations/gen-123.mp4');
  });

  it('throws and never calls r2.send when fetch resolves with a non-ok status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 404,
      body: null,
    });

    await expect(archiveToR2('https://replicate.delivery/expired.mp4', 'gen-456')).rejects.toThrow('404');
    expect(r2.send).not.toHaveBeenCalled();
  });
});
