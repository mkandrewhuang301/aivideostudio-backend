const mockR2Send = jest.fn();
jest.mock('../../storage/r2', () => ({
  r2: { send: mockR2Send },
  R2_BUCKET: 'test-bucket',
}));

import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { quarantineGenerationMedia } from '../../services/quarantineService';

beforeEach(() => {
  jest.clearAllMocks();
  mockR2Send.mockResolvedValue({});
});

it('copies under quarantine before deleting the delivery object', async () => {
  const key = await quarantineGenerationMedia('gen-1', 'generations/folder/output clip.mp4');

  expect(key).toBe('quarantine/gen-1/output clip.mp4');
  const [copy, remove] = mockR2Send.mock.calls.map(([command]) => command);
  expect(copy).toBeInstanceOf(CopyObjectCommand);
  expect(copy.input).toEqual({
    Bucket: 'test-bucket',
    CopySource: 'test-bucket/generations/folder/output%20clip.mp4',
    Key: 'quarantine/gen-1/output clip.mp4',
  });
  expect(remove).toBeInstanceOf(DeleteObjectCommand);
  expect(remove.input).toEqual({ Bucket: 'test-bucket', Key: 'generations/folder/output clip.mp4' });
  expect(mockR2Send.mock.invocationCallOrder[0]).toBeLessThan(mockR2Send.mock.invocationCallOrder[1]);
});

it('never deletes the only artifact when the quarantine copy fails', async () => {
  mockR2Send.mockRejectedValueOnce(new Error('copy failed'));

  await expect(quarantineGenerationMedia('gen-1', 'generations/output.mp4'))
    .rejects.toThrow('copy failed');
  expect(mockR2Send).toHaveBeenCalledTimes(1);
});

it('is idempotent for an object already under quarantine', async () => {
  await expect(quarantineGenerationMedia('gen-1', 'quarantine/gen-1/output.mp4'))
    .resolves.toBe('quarantine/gen-1/output.mp4');
  expect(mockR2Send).not.toHaveBeenCalled();
});
