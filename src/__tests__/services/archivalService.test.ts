// src/__tests__/services/archivalService.test.ts
// Unit tests for archiveToR2 — fetches Replicate output and streams it to R2 as the
// FIRST side effect (CLAUDE.md Rule 2: Replicate output URLs expire).
// Perf: archiveToR2 now streams via @aws-sdk/lib-storage's Upload instead of buffering the
// whole file into memory first. Upload's real internals need a fully-shaped S3Client (they
// inspect client.config), so — consistent with how this suite mocks at the SDK-call boundary
// elsewhere — Upload itself is mocked here and we assert it was constructed with the right
// Bucket/Key/ContentType/Body, rather than exercising lib-storage's real request machinery.

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

const mockDone = jest.fn().mockResolvedValue({});
const mockUploadCtor = jest.fn().mockImplementation(() => ({ done: mockDone }));
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: mockUploadCtor,
}));

import { Readable } from 'node:stream';
import { archiveToR2 } from '../../services/archivalService';

function fakeWebStreamFrom(text: string) {
  const nodeStream = Readable.from([Buffer.from(text)]);
  return Readable.toWeb(nodeStream);
}

describe('archiveToR2', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDone.mockResolvedValue({});
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('fetches the output URL and uploads it to R2 under generations/{id}.mp4', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: fakeWebStreamFrom('fake-video-bytes'),
    });

    const key = await archiveToR2('https://replicate.delivery/abc.mp4', 'gen-123');

    expect(global.fetch).toHaveBeenCalledWith('https://replicate.delivery/abc.mp4');
    expect(mockUploadCtor).toHaveBeenCalledTimes(1);
    const uploadArgs = mockUploadCtor.mock.calls[0][0];
    expect(uploadArgs.params.Bucket).toBe('test-bucket');
    expect(uploadArgs.params.Key).toBe('generations/gen-123.mp4');
    expect(uploadArgs.params.ContentType).toBe('video/mp4');
    expect(uploadArgs.params.Body).toBeInstanceOf(Readable);
    expect(mockDone).toHaveBeenCalledTimes(1);
    expect(key).toBe('generations/gen-123.mp4');
  });

  it('derives the correct extension for image content types', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: fakeWebStreamFrom('fake-image-bytes'),
    });

    const key = await archiveToR2('https://replicate.delivery/abc.png', 'gen-789', 'image/png');

    const uploadArgs = mockUploadCtor.mock.calls[0][0];
    expect(uploadArgs.params.Key).toBe('generations/gen-789.png');
    expect(key).toBe('generations/gen-789.png');
  });

  it('throws and never constructs an Upload when fetch resolves with a non-ok status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 404,
      body: null,
    });

    await expect(archiveToR2('https://replicate.delivery/expired.mp4', 'gen-456')).rejects.toThrow('404');
    expect(mockUploadCtor).not.toHaveBeenCalled();
  });
});
