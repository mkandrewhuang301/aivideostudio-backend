// src/__tests__/queue/hiveScanWorker.test.ts
// Tests for processHiveScan (retry job handler) and handleScanFinalFailure (exhausted handler).
// No live Redis required — BullMQ is mocked; logic is tested via exported named functions.

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn(), close: jest.fn() })),
  Worker: jest.fn().mockImplementation(() => ({ close: jest.fn(), on: jest.fn() })),
}));

jest.mock('../../config', () => ({
  config: {
    replicateWebhookSecret: 'whsec_test',
    databaseUrl: 'mock://db',
    redisUrl: 'redis://localhost',
    r2AccountId: 'mock', r2AccessKeyId: 'mock', r2SecretAccessKey: 'mock',
    r2BucketName: 'mock', r2PublicDomain: '',
    firebaseProjectId: 'mock', firebaseClientEmail: 'mock@mock.iam.gserviceaccount.com',
    firebasePrivateKey: 'mock-key', apnsAuthKey: 'mock-key', apnsKeyId: 'mock',
    apnsTeamId: 'mock', apnsBundleId: 'mock', replicateApiToken: 'mock-token',
    hiveApiKey: 'mock-hive-key', publicBaseUrl: 'https://mock.example.com',
    port: 3000, nodeEnv: 'test',
  },
}));

jest.mock('../../services/hiveService', () => ({ scanForCsam: jest.fn() }));
jest.mock('../../services/generationService', () => ({
  markCompleted: jest.fn(),
  markFailed: jest.fn(),
  markQuarantined: jest.fn(),
}));
jest.mock('../../services/moderationEnforcementService', () => ({
  enforceFlaggedGeneration: jest.fn(),
}));
jest.mock('../../services/creditService', () => ({ refundCredits: jest.fn() }));
jest.mock('../../services/apnsService', () => ({ sendGenerationComplete: jest.fn() }));
jest.mock('../../db/client', () => ({ db: { execute: jest.fn() } }));

import { scanForCsam } from '../../services/hiveService';
import { markCompleted, markFailed, markQuarantined } from '../../services/generationService';
import { refundCredits } from '../../services/creditService';
import { sendGenerationComplete } from '../../services/apnsService';
import { db } from '../../db/client';
import { enforceFlaggedGeneration } from '../../services/moderationEnforcementService';
import { processHiveScan, handleScanFinalFailure, HIVE_SCAN_ATTEMPTS } from '../../queue/hiveScanWorker';

const JOB_DATA = {
  generationId: 'gen-hive-1',
  r2Key: 'generations/gen-hive-1.mp4',
  userId: 'user-1',
  costCredits: 60,
  mediaType: 'video' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  (db.execute as jest.Mock).mockResolvedValue({ rows: [{ apns_device_token: 'token-abc' }] });
  (markCompleted as jest.Mock).mockResolvedValue(true);
  (markFailed as jest.Mock).mockResolvedValue(true);
  (markQuarantined as jest.Mock).mockResolvedValue(true);
  (refundCredits as jest.Mock).mockResolvedValue(undefined);
  (sendGenerationComplete as jest.Mock).mockResolvedValue(undefined);
});

describe('processHiveScan', () => {
  it('marks completed and sends push when scan passes', async () => {
    (scanForCsam as jest.Mock).mockResolvedValue({ flagged: false });

    await processHiveScan(JOB_DATA);

    expect(scanForCsam).toHaveBeenCalledWith(JOB_DATA.r2Key);
    expect(markCompleted).toHaveBeenCalledWith(JOB_DATA.generationId, JOB_DATA.r2Key);
    expect(sendGenerationComplete).toHaveBeenCalledWith('token-abc', JOB_DATA.generationId, 'video');
    expect(markQuarantined).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it('passes mediaType through so an image retry never sends the video push copy', async () => {
    (scanForCsam as jest.Mock).mockResolvedValue({ flagged: false });

    await processHiveScan({ ...JOB_DATA, r2Key: 'generations/gen-hive-1.jpg', mediaType: 'image' });

    expect(sendGenerationComplete).toHaveBeenCalledWith('token-abc', JOB_DATA.generationId, 'image');
  });

  it('routes a flagged retry through two-tier enforcement — never marks completed', async () => {
    const result = { flagged: true, tier: 'low', childScore: 0.8, sexualScore: 0.7, hashMatched: false };
    (scanForCsam as jest.Mock).mockResolvedValue(result);

    await processHiveScan(JOB_DATA);

    expect(enforceFlaggedGeneration).toHaveBeenCalledWith({
      generationId: JOB_DATA.generationId,
      r2Key: JOB_DATA.r2Key,
      userId: JOB_DATA.userId,
      costCredits: JOB_DATA.costCredits,
    }, result);
    expect(markCompleted).not.toHaveBeenCalled();
    expect(sendGenerationComplete).not.toHaveBeenCalled();
  });

  it('throws when Hive errors — lets BullMQ handle the retry', async () => {
    (scanForCsam as jest.Mock).mockRejectedValue(new Error('Hive timeout'));

    await expect(processHiveScan(JOB_DATA)).rejects.toThrow('Hive timeout');

    expect(markCompleted).not.toHaveBeenCalled();
    expect(markQuarantined).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it('still marks completed when push notification throws — push failure is non-blocking', async () => {
    (scanForCsam as jest.Mock).mockResolvedValue({ flagged: false });
    (sendGenerationComplete as jest.Mock).mockRejectedValue(new Error('APNs down'));

    await expect(processHiveScan(JOB_DATA)).resolves.not.toThrow();

    expect(markCompleted).toHaveBeenCalledWith(JOB_DATA.generationId, JOB_DATA.r2Key);
  });

  it('skips push when no device token is registered for the user', async () => {
    (scanForCsam as jest.Mock).mockResolvedValue({ flagged: false });
    (db.execute as jest.Mock).mockResolvedValue({ rows: [{ apns_device_token: null }] });

    await processHiveScan(JOB_DATA);

    expect(markCompleted).toHaveBeenCalled();
    expect(sendGenerationComplete).not.toHaveBeenCalled();
  });
});

describe('handleScanFinalFailure', () => {
  it('marks failed WITH the r2Key (so the already-archived object stays referenced, not orphaned) and refunds credits with hive-timeout idempotency key', async () => {
    const err = new Error('Hive still down after all retries');

    await handleScanFinalFailure(JOB_DATA, err);

    expect(markFailed).toHaveBeenCalledWith(JOB_DATA.generationId, 'generic_error', JOB_DATA.r2Key);
    expect(refundCredits).toHaveBeenCalledWith(
      JOB_DATA.userId, JOB_DATA.costCredits, `hive-timeout-${JOB_DATA.generationId}`,
    );
  });

  it('still refunds even if markFailed throws — both operations are attempted', async () => {
    (markFailed as jest.Mock).mockRejectedValue(new Error('DB error'));

    await expect(handleScanFinalFailure(JOB_DATA, new Error('Hive down'))).resolves.not.toThrow();

    expect(refundCredits).toHaveBeenCalledWith(
      JOB_DATA.userId, JOB_DATA.costCredits, `hive-timeout-${JOB_DATA.generationId}`,
    );
  });

  it('HIVE_SCAN_ATTEMPTS constant matches the queue defaultJobOptions attempts', () => {
    expect(HIVE_SCAN_ATTEMPTS).toBe(6);
  });
});
