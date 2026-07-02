// src/__tests__/queue/uploadReaperWorker.test.ts
// Unit tests for the BullMQ upload reaper: deletes unnamed reference_uploads rows older than
// 24 hours (R2 object + DB row), leaves named references untouched, and schedules hourly.
// All BullMQ, DB, and R2 calls are mocked: no live Redis/Postgres/R2 connection required.

jest.mock('bullmq', () => {
  const QueueMock = jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    close: jest.fn(),
  }));
  const WorkerMock = jest.fn().mockImplementation(() => ({
    close: jest.fn(),
    on: jest.fn(),
  }));
  return { Queue: QueueMock, Worker: WorkerMock };
});

jest.mock('../../db/client', () => ({
  db: {
    execute: jest.fn(),
  },
}));

const mockR2Send = jest.fn();
jest.mock('../../storage/r2', () => ({
  r2: { send: (...args: unknown[]) => mockR2Send(...args) },
  R2_BUCKET: 'test-bucket',
}));

import { db } from '../../db/client';
import {
  reapUnnamedUploads,
  scheduleUploadReaper,
  uploadReaperQueue,
} from '../../queue/uploadReaperWorker';

const mockDbExecute = db.execute as jest.Mock;

function extractSql(drizzleQuery: unknown): string {
  if (typeof drizzleQuery === 'string') return drizzleQuery;
  const q = drizzleQuery as { queryChunks?: Array<{ value?: string[] } | unknown> };
  if (q.queryChunks) {
    return q.queryChunks
      .map((chunk) => {
        if (chunk && typeof chunk === 'object' && 'value' in chunk) {
          const c = chunk as { value: string[] };
          return Array.isArray(c.value) ? c.value.join('') : '';
        }
        return '';
      })
      .join('');
  }
  return String(drizzleQuery);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reapUnnamedUploads', () => {
  it('selects unnamed uploads older than 24 hours, deletes the R2 object, then the DB row', async () => {
    mockDbExecute
      .mockResolvedValueOnce({ rows: [{ id: 'upload-1', r2_key: 'uploads/user-1/abc.jpg' }] })
      .mockResolvedValueOnce({ rows: [] });
    mockR2Send.mockResolvedValueOnce({});

    await reapUnnamedUploads();

    const selectSql = extractSql(mockDbExecute.mock.calls[0][0]);
    expect(selectSql).toMatch(/display_name IS NULL/);
    expect(selectSql).toMatch(/interval '24 hours'/);

    expect(mockR2Send).toHaveBeenCalledTimes(1);
    const deleteSql = extractSql(mockDbExecute.mock.calls[1][0]);
    expect(deleteSql).toMatch(/DELETE FROM reference_uploads/);
  });

  it('performs no R2/DB delete calls when zero rows match (no-op)', async () => {
    mockDbExecute.mockResolvedValueOnce({ rows: [] });

    await reapUnnamedUploads();

    expect(mockR2Send).not.toHaveBeenCalled();
    expect(mockDbExecute).toHaveBeenCalledTimes(1);
  });

  it('continues to the next row when one deletion fails', async () => {
    mockDbExecute
      .mockResolvedValueOnce({
        rows: [
          { id: 'upload-1', r2_key: 'uploads/user-1/abc.jpg' },
          { id: 'upload-2', r2_key: 'uploads/user-1/def.jpg' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    mockR2Send.mockRejectedValueOnce(new Error('R2 unavailable')).mockResolvedValueOnce({});

    await reapUnnamedUploads();

    expect(mockR2Send).toHaveBeenCalledTimes(2);
    // Only one DELETE FROM reference_uploads should have run (for the row whose R2 delete succeeded),
    // plus the initial SELECT — 2 total db.execute calls.
    expect(mockDbExecute).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleUploadReaper', () => {
  it('calls uploadReaperQueue.add with an hourly repeat and singleton jobId exactly once', async () => {
    await scheduleUploadReaper();

    expect(uploadReaperQueue.add).toHaveBeenCalledTimes(1);
    expect(uploadReaperQueue.add).toHaveBeenCalledWith(
      'reap',
      {},
      { repeat: { every: 60 * 60 * 1000 }, jobId: 'upload-reaper-singleton' },
    );
  });
});
