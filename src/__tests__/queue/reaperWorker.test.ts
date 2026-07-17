// src/__tests__/queue/reaperWorker.test.ts
// Unit tests for the BullMQ reaper: orphan refund path, stalled reconciliation (complete/refund),
// the shared-guard race protection (RESEARCH.md Pitfall 2), and the 5-minute repeatable schedule.
// All BullMQ, DB, and provider calls are mocked: no live Redis/Postgres/Replicate connection required.

jest.mock('../../config', () => ({
  config: { hiveScanEnabled: true },
}));

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

jest.mock('../../services/generationService', () => ({
  markRefunded: jest.fn(),
  markCompleted: jest.fn(),
  markQuarantined: jest.fn(),
}));

jest.mock('../../services/hiveService', () => ({
  scanForCsam: jest.fn(),
}));

jest.mock('../../services/creditService', () => ({
  refundCredits: jest.fn(),
}));

jest.mock('../../services/archivalService', () => ({
  archiveToR2: jest.fn(),
}));

const mockGetStatus = jest.fn();
const mockGetFalStatus = jest.fn();

jest.mock('../../services/providers/ReplicateProvider', () => ({
  ReplicateProvider: jest.fn().mockImplementation(() => ({
    getStatus: mockGetStatus,
  })),
}));

jest.mock('../../services/providers/FalProvider', () => ({
  FAL_KLING_V3_STANDARD_I2V_MODEL: 'fal-ai/kling-video/v3/standard/image-to-video',
  isFalAsyncVideoModel: jest.fn((model: string) => [
    'fal-ai/kling-video/v3/standard/image-to-video',
    'pixelcut/video-background-removal',
  ].includes(model)),
  falVideoOutputContentType: jest.fn((model: string) =>
    model === 'pixelcut/video-background-removal' ? 'video/quicktime' : 'video/mp4'),
  FalProvider: jest.fn().mockImplementation(() => ({
    getStatus: mockGetFalStatus,
  })),
}));

import { db } from '../../db/client';
import { markRefunded, markCompleted, markQuarantined } from '../../services/generationService';
import { refundCredits } from '../../services/creditService';
import { archiveToR2 } from '../../services/archivalService';
import { scanForCsam } from '../../services/hiveService';
import {
  reapOrphanedJobs,
  reapStalledJobs,
  scheduleReaper,
  reaperQueue,
} from '../../queue/reaperWorker';

const mockDbExecute = db.execute as jest.Mock;
const mockMarkRefunded = markRefunded as jest.Mock;
const mockMarkCompleted = markCompleted as jest.Mock;
const mockMarkQuarantined = markQuarantined as jest.Mock;
const mockRefundCredits = refundCredits as jest.Mock;
const mockArchiveToR2 = archiveToR2 as jest.Mock;
const mockScanForCsam = scanForCsam as jest.Mock;

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

// ─── reapOrphanedJobs ───────────────────────────────────────────────────────

describe('reapOrphanedJobs', () => {
  it('selects pending generations older than 5 minutes, refunds credits, then marks refunded', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        { id: 'gen-1', user_id: 'user-1', cost_credits: 45, replicate_prediction_id: 'pred-1' },
      ],
    });
    mockMarkRefunded.mockResolvedValueOnce(true);

    await reapOrphanedJobs();

    const sqlText = extractSql(mockDbExecute.mock.calls[0][0]);
    expect(sqlText).toMatch(/'pending'/);
    expect(sqlText).toMatch(/interval '5 minutes'/);

    expect(mockMarkRefunded).toHaveBeenCalledWith('gen-1');
    expect(mockRefundCredits).toHaveBeenCalledWith('user-1', 45, 'pred-1');
  });

  it('performs no refund/markRefunded calls when zero rows match (no-op)', async () => {
    mockDbExecute.mockResolvedValueOnce({ rows: [] });

    await reapOrphanedJobs();

    expect(mockMarkRefunded).not.toHaveBeenCalled();
    expect(mockRefundCredits).not.toHaveBeenCalled();
  });

  it('skips the refund side effect when markRefunded returns false (already transitioned)', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        { id: 'gen-2', user_id: 'user-2', cost_credits: 30, replicate_prediction_id: 'pred-2' },
      ],
    });
    mockMarkRefunded.mockResolvedValueOnce(false);

    await reapOrphanedJobs();

    expect(mockMarkRefunded).toHaveBeenCalledWith('gen-2');
    expect(mockRefundCredits).not.toHaveBeenCalled();
  });

  it('keeps the 5-minute non-format window but selects format rows only after 90 minutes', async () => {
    mockDbExecute.mockResolvedValueOnce({
      // Represents the database returning a format row older than the query's 90-minute cutoff.
      rows: [
        {
          id: 'format-pending-over-90',
          user_id: 'user-format',
          cost_credits: 470,
          replicate_prediction_id: null,
          media_type: 'format',
        },
      ],
    });
    mockMarkRefunded.mockResolvedValueOnce(true);

    await reapOrphanedJobs();

    const sqlText = extractSql(mockDbExecute.mock.calls[0][0]);
    expect(sqlText).toMatch(/created_at < now\(\) - interval '5 minutes'/);
    expect(sqlText).toMatch(/media_type != 'format'/);
    expect(sqlText).toMatch(/created_at < now\(\) - interval '90 minutes'/);
    expect(mockMarkRefunded).toHaveBeenCalledWith('format-pending-over-90');
  });
});

// ─── reapStalledJobs ────────────────────────────────────────────────────────

describe('reapStalledJobs', () => {
  it('selects processing generations older than 30 minutes', async () => {
    mockDbExecute.mockResolvedValueOnce({ rows: [] });

    await reapStalledJobs();

    const sqlText = extractSql(mockDbExecute.mock.calls[0][0]);
    expect(sqlText).toMatch(/'processing'/);
    expect(sqlText).toMatch(/interval '30 minutes'/);
    expect(sqlText).toMatch(/model/);
  });

  it('routes only regular fal Kling v3 rows to FalProvider while Motion Control stays on Replicate', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        {
          id: 'gen-fal', user_id: 'user-fal', cost_credits: 63,
          replicate_prediction_id: 'fal-ai/kling-video/v3/standard/image-to-video::req-1',
          model: 'fal-ai/kling-video/v3/standard/image-to-video',
        },
        {
          id: 'gen-motion', user_id: 'user-motion', cost_credits: 129,
          replicate_prediction_id: 'replicate-motion-1',
          model: 'kwaivgi/kling-v3-motion-control',
        },
      ],
    });
    mockGetFalStatus.mockResolvedValueOnce({ status: 'processing' });
    mockGetStatus.mockResolvedValueOnce({ status: 'processing' });

    await reapStalledJobs();

    expect(mockGetFalStatus).toHaveBeenCalledWith(
      'fal-ai/kling-video/v3/standard/image-to-video::req-1',
    );
    expect(mockGetStatus).toHaveBeenCalledWith('replicate-motion-1');
  });

  it('reconciles Pixelcut transparent video through fal and preserves the QuickTime container', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [{
        id: 'gen-alpha', user_id: 'user-alpha', cost_credits: 9,
        replicate_prediction_id: 'pixelcut/video-background-removal::req-alpha',
        model: 'pixelcut/video-background-removal',
      }],
    });
    mockGetFalStatus.mockResolvedValueOnce({
      status: 'succeeded',
      outputUrl: 'https://fal.media/cutout.mov',
    });
    mockArchiveToR2.mockResolvedValueOnce('generations/gen-alpha.mov');
    mockScanForCsam.mockResolvedValueOnce({ flagged: false });
    mockMarkCompleted.mockResolvedValueOnce(true);

    await reapStalledJobs();

    expect(mockGetFalStatus).toHaveBeenCalledWith(
      'pixelcut/video-background-removal::req-alpha',
    );
    expect(mockArchiveToR2).toHaveBeenCalledWith(
      'https://fal.media/cutout.mov',
      'gen-alpha',
      'video/quicktime',
    );
    expect(mockMarkCompleted).toHaveBeenCalledWith('gen-alpha', 'generations/gen-alpha.mov');
  });

  it('archives to R2, scans for CSAM, and marks completed when Replicate reports succeeded', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        { id: 'gen-3', user_id: 'user-3', cost_credits: 60, replicate_prediction_id: 'pred-3' },
      ],
    });
    mockGetStatus.mockResolvedValueOnce({
      status: 'succeeded',
      outputUrl: 'https://replicate.delivery/output.mp4',
    });
    mockArchiveToR2.mockResolvedValueOnce('generations/gen-3.mp4');
    mockScanForCsam.mockResolvedValueOnce({ flagged: false });
    mockMarkCompleted.mockResolvedValueOnce(true);

    await reapStalledJobs();

    expect(mockGetStatus).toHaveBeenCalledWith('pred-3');
    expect(mockArchiveToR2).toHaveBeenCalledWith(
      'https://replicate.delivery/output.mp4',
      'gen-3',
      'video/mp4',
    );
    expect(mockScanForCsam).toHaveBeenCalledWith('generations/gen-3.mp4');
    expect(mockMarkCompleted).toHaveBeenCalledWith('gen-3', 'generations/gen-3.mp4');
    expect(mockMarkRefunded).not.toHaveBeenCalled();
    expect(mockMarkQuarantined).not.toHaveBeenCalled();
  });

  it('quarantines and refunds when Hive flags the video during reaper reconciliation', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        { id: 'gen-3b', user_id: 'user-3b', cost_credits: 60, replicate_prediction_id: 'pred-3b' },
      ],
    });
    mockGetStatus.mockResolvedValueOnce({
      status: 'succeeded',
      outputUrl: 'https://replicate.delivery/flagged.mp4',
    });
    mockArchiveToR2.mockResolvedValueOnce('generations/gen-3b.mp4');
    mockScanForCsam.mockResolvedValueOnce({ flagged: true });
    mockMarkQuarantined.mockResolvedValueOnce(true);

    await reapStalledJobs();

    expect(mockMarkQuarantined).toHaveBeenCalledWith('gen-3b');
    expect(mockRefundCredits).toHaveBeenCalledWith('user-3b', 60, 'csam-quarantine-reaper-gen-3b');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('quarantines and refunds when Hive throws during reaper reconciliation (fail-safe)', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        { id: 'gen-3c', user_id: 'user-3c', cost_credits: 45, replicate_prediction_id: 'pred-3c' },
      ],
    });
    mockGetStatus.mockResolvedValueOnce({
      status: 'succeeded',
      outputUrl: 'https://replicate.delivery/video.mp4',
    });
    mockArchiveToR2.mockResolvedValueOnce('generations/gen-3c.mp4');
    mockScanForCsam.mockRejectedValueOnce(new Error('Hive timeout'));
    mockMarkQuarantined.mockResolvedValueOnce(true);

    await reapStalledJobs();

    expect(mockMarkQuarantined).toHaveBeenCalledWith('gen-3c');
    expect(mockRefundCredits).toHaveBeenCalledWith('user-3c', 45, 'csam-quarantine-reaper-gen-3c');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('refunds credits when Replicate reports failed', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        { id: 'gen-4', user_id: 'user-4', cost_credits: 50, replicate_prediction_id: 'pred-4' },
      ],
    });
    mockGetStatus.mockResolvedValueOnce({ status: 'failed' });
    mockMarkRefunded.mockResolvedValueOnce(true);

    await reapStalledJobs();

    expect(mockMarkRefunded).toHaveBeenCalledWith('gen-4');
    expect(mockRefundCredits).toHaveBeenCalledWith('user-4', 50, 'pred-4');
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('refunds credits when Replicate reports canceled', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        { id: 'gen-5', user_id: 'user-5', cost_credits: 20, replicate_prediction_id: 'pred-5' },
      ],
    });
    mockGetStatus.mockResolvedValueOnce({ status: 'canceled' });
    mockMarkRefunded.mockResolvedValueOnce(true);

    await reapStalledJobs();

    expect(mockMarkRefunded).toHaveBeenCalledWith('gen-5');
    expect(mockRefundCredits).toHaveBeenCalledWith('user-5', 20, 'pred-5');
  });

  it('refunds credits when getStatus throws (Replicate API error, T-04-05-02)', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        { id: 'gen-6', user_id: 'user-6', cost_credits: 40, replicate_prediction_id: 'pred-6' },
      ],
    });
    mockGetStatus.mockRejectedValueOnce(new Error('Replicate API down'));
    mockMarkRefunded.mockResolvedValueOnce(true);

    await expect(reapStalledJobs()).resolves.not.toThrow();

    expect(mockMarkRefunded).toHaveBeenCalledWith('gen-6');
    expect(mockRefundCredits).toHaveBeenCalledWith('user-6', 40, 'pred-6');
  });

  it('refunds without calling Replicate when replicate_prediction_id is null', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        { id: 'gen-7', user_id: 'user-7', cost_credits: 15, replicate_prediction_id: null },
      ],
    });
    mockMarkRefunded.mockResolvedValueOnce(true);

    await reapStalledJobs();

    expect(mockGetStatus).not.toHaveBeenCalled();
    expect(mockMarkRefunded).toHaveBeenCalledWith('gen-7');
    expect(mockRefundCredits).toHaveBeenCalledWith('user-7', 15, 'gen-7');
  });

  it('uses the SAME guarded generationService functions (shared-guard race protection)', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        { id: 'gen-8', user_id: 'user-8', cost_credits: 25, replicate_prediction_id: 'pred-8' },
      ],
    });
    mockGetStatus.mockResolvedValueOnce({
      status: 'succeeded',
      outputUrl: 'https://replicate.delivery/output8.mp4',
    });
    mockArchiveToR2.mockResolvedValueOnce('generations/gen-8.mp4');
    mockScanForCsam.mockResolvedValueOnce({ flagged: false });
    mockMarkCompleted.mockResolvedValueOnce(true);

    await reapStalledJobs();

    // Identity check: the exact mocked function imported from generationService was invoked.
    expect(mockMarkCompleted).toBe(markCompleted);
    expect(mockMarkCompleted.mock.calls.length).toBeGreaterThan(0);

    // No raw inline UPDATE statement was issued for the status transition itself —
    // db.execute was only called once in this test, for the initial SELECT.
    expect(mockDbExecute).toHaveBeenCalledTimes(1);
  });

  it('skips refund side effect when markRefunded returns false (webhook already won the race)', async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        { id: 'gen-9', user_id: 'user-9', cost_credits: 35, replicate_prediction_id: 'pred-9' },
      ],
    });
    mockGetStatus.mockResolvedValueOnce({ status: 'failed' });
    mockMarkRefunded.mockResolvedValueOnce(false);

    await reapStalledJobs();

    expect(mockMarkRefunded).toHaveBeenCalledWith('gen-9');
    expect(mockRefundCredits).not.toHaveBeenCalled();
  });

  it('keeps the 30-minute non-format window but selects format rows only after 90 minutes', async () => {
    mockDbExecute.mockResolvedValueOnce({
      // Represents the database returning a format row older than the query's 90-minute cutoff.
      rows: [
        {
          id: 'format-processing-over-90',
          user_id: 'user-format',
          cost_credits: 470,
          replicate_prediction_id: null,
          model: '',
          media_type: 'format',
        },
      ],
    });
    mockMarkRefunded.mockResolvedValueOnce(true);

    await reapStalledJobs();

    const sqlText = extractSql(mockDbExecute.mock.calls[0][0]);
    expect(sqlText).toMatch(/created_at < now\(\) - interval '30 minutes'/);
    expect(sqlText).toMatch(/media_type != 'format'/);
    expect(sqlText).toMatch(/created_at < now\(\) - interval '90 minutes'/);
    expect(mockMarkRefunded).toHaveBeenCalledWith('format-processing-over-90');
  });
});

// ─── scheduleReaper ─────────────────────────────────────────────────────────

describe('scheduleReaper', () => {
  it('calls reaperQueue.add with a 5-minute repeat and singleton jobId exactly once', async () => {
    await scheduleReaper();

    expect(reaperQueue.add).toHaveBeenCalledTimes(1);
    expect(reaperQueue.add).toHaveBeenCalledWith(
      'reap',
      {},
      { repeat: { every: 5 * 60 * 1000 }, jobId: 'reaper-singleton' },
    );
  });
});
