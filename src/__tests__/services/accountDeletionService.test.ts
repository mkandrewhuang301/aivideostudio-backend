const mockExecute = jest.fn();
const mockBatch = jest.fn();
const mockDelete = jest.fn();
jest.mock('../../db/client', () => ({
  db: {
    execute: mockExecute,
    batch: mockBatch,
    delete: mockDelete,
  },
}));

const mockR2Send = jest.fn();
jest.mock('../../storage/r2', () => ({
  r2: { send: mockR2Send },
  R2_BUCKET: 'test-bucket',
}));

const mockFirebaseDeleteUser = jest.fn();
jest.mock('../../firebase', () => ({
  getFirebaseAdmin: () => ({ auth: { deleteUser: mockFirebaseDeleteUser } }),
}));

const mockEvictAuthCache = jest.fn();
jest.mock('../../middleware/auth', () => ({
  evictAuthCache: mockEvictAuthCache,
}));

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  creditTransactions,
  generations,
  projectAudioClips,
  projectCaptionCues,
  projectCaptionWords,
  projectClips,
  projects,
  projectTextOverlays,
  referenceUploads,
  reports,
  users,
} from '../../db/schema';
import { deleteUserAccount } from '../../services/accountDeletionService';

const tableNames = new Map<unknown, string>([
  [projectCaptionWords, 'project_caption_words'],
  [projectCaptionCues, 'project_caption_cues'],
  [projectAudioClips, 'project_audio_clips'],
  [projectTextOverlays, 'project_text_overlays'],
  [projectClips, 'project_clips'],
  [projects, 'projects'],
  [reports, 'reports'],
  [generations, 'generations'],
  [referenceUploads, 'reference_uploads'],
  [creditTransactions, 'credit_transactions'],
  [users, 'users'],
]);

beforeEach(() => {
  jest.clearAllMocks();
  mockExecute.mockResolvedValue({
    rows: [
      { r2_key: 'generations/user/video.mp4' },
      { r2_key: 'uploads/user/reference.jpg' },
      { r2_key: 'projects/user/thumbnail.jpg' },
      { r2_key: 'projects/user/clips/clip.mp4' },
      { r2_key: 'projects/user/audio/audio.mp3' },
    ],
  });
  mockR2Send.mockResolvedValue({});
  mockBatch.mockResolvedValue([]);
  mockFirebaseDeleteUser.mockResolvedValue(undefined);
  mockDelete.mockImplementation((table: unknown) => ({
    where: jest.fn().mockReturnValue({ tableName: tableNames.get(table) }),
  }));
});

it('deletes every owned R2 key, batches DB deletes in FK order, then deletes Firebase and evicts cache', async () => {
  await deleteUserAccount('11111111-1111-4111-8111-111111111111', 'firebase-user-1');

  const r2Commands = mockR2Send.mock.calls.map(([command]) => command as DeleteObjectCommand);
  expect(r2Commands.map((command) => command.input)).toEqual([
    { Bucket: 'test-bucket', Key: 'generations/user/video.mp4' },
    { Bucket: 'test-bucket', Key: 'uploads/user/reference.jpg' },
    { Bucket: 'test-bucket', Key: 'projects/user/thumbnail.jpg' },
    { Bucket: 'test-bucket', Key: 'projects/user/clips/clip.mp4' },
    { Bucket: 'test-bucket', Key: 'projects/user/audio/audio.mp3' },
  ]);

  const collectionSql = JSON.stringify(mockExecute.mock.calls[0][0]);
  for (const source of ['generations', 'reference_uploads', 'projects', 'project_clips', 'project_audio_clips']) {
    expect(collectionSql).toContain(source);
  }

  const batch = mockBatch.mock.calls[0][0] as Array<{ tableName: string }>;
  expect(batch.map((query) => query.tableName)).toEqual([
    'project_caption_words',
    'project_caption_cues',
    'project_audio_clips',
    'project_text_overlays',
    'project_clips',
    'projects',
    'reports',
    'generations',
    'reference_uploads',
    'credit_transactions',
    'users',
  ]);
  expect(mockFirebaseDeleteUser).toHaveBeenCalledWith('firebase-user-1');
  expect(mockEvictAuthCache).toHaveBeenCalledWith('firebase-user-1');
  expect(mockFirebaseDeleteUser.mock.invocationCallOrder[0]).toBeLessThan(
    mockEvictAuthCache.mock.invocationCallOrder[0],
  );
});

it('continues through DB, Firebase, and cache deletion when an R2 object delete fails', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockR2Send.mockRejectedValueOnce(new Error('R2 unavailable'));

  await expect(deleteUserAccount('11111111-1111-4111-8111-111111111111', 'firebase-user-1'))
    .resolves.toBeUndefined();

  expect(mockR2Send).toHaveBeenCalledTimes(5);
  expect(mockBatch).toHaveBeenCalledTimes(1);
  expect(mockFirebaseDeleteUser).toHaveBeenCalledWith('firebase-user-1');
  expect(mockEvictAuthCache).toHaveBeenCalledWith('firebase-user-1');
  consoleError.mockRestore();
});

it('aborts before Firebase deletion and cache eviction when the DB transaction fails', async () => {
  mockBatch.mockRejectedValueOnce(new Error('transaction failed'));

  await expect(deleteUserAccount('11111111-1111-4111-8111-111111111111', 'firebase-user-1'))
    .rejects.toThrow('transaction failed');

  expect(mockFirebaseDeleteUser).not.toHaveBeenCalled();
  expect(mockEvictAuthCache).not.toHaveBeenCalled();
});

it('logs a critical Firebase failure, evicts the cache, and still resolves after the DB commit', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockFirebaseDeleteUser.mockRejectedValueOnce(new Error('Firebase unavailable'));

  await expect(deleteUserAccount('11111111-1111-4111-8111-111111111111', 'firebase-user-1'))
    .resolves.toBeUndefined();

  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining('CRITICAL: Firebase user deletion failed for uid firebase-user-1'),
    expect.any(Error),
  );
  expect(mockEvictAuthCache).toHaveBeenCalledWith('firebase-user-1');
  consoleError.mockRestore();
});
