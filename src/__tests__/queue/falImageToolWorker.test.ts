// Unit coverage for the blocking fal image-tool worker. BullMQ and every external service are
// mocked; no Redis, provider, R2, Hive, or database connection is used.

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn(), close: jest.fn() })),
  Worker: jest.fn().mockImplementation(() => ({ close: jest.fn(), on: jest.fn() })),
}));

jest.mock('../../config', () => ({
  config: {
    databaseUrl: 'mock://db', redisUrl: 'redis://localhost',
    r2AccountId: 'mock', r2AccessKeyId: 'mock', r2SecretAccessKey: 'mock',
    r2BucketName: 'mock', r2PublicDomain: '',
    firebaseProjectId: 'mock', firebaseClientEmail: 'mock@mock.iam.gserviceaccount.com',
    firebasePrivateKey: 'mock-key', apnsAuthKey: 'mock-key', apnsKeyId: 'mock',
    apnsTeamId: 'mock', apnsBundleId: 'mock', replicateApiToken: 'mock-token',
    hiveApiKey: 'mock-hive-key', openaiApiKey: 'mock-openai-key',
    publicBaseUrl: 'https://mock.example.com', port: 3000, nodeEnv: 'test',
    hiveScanRealFacePaths: true,
  },
}));

jest.mock('../../services/providers/FalProvider', () => ({
  falRunImageBackgroundRemoval: jest.fn(),
}));
jest.mock('../../services/archivalService', () => ({ archiveToR2: jest.fn() }));
jest.mock('../../services/hiveService', () => ({ scanForCsam: jest.fn() }));
jest.mock('../../services/generationService', () => ({
  markCompleted: jest.fn(),
  markFailed: jest.fn(),
  markQuarantined: jest.fn(),
  classifyFailureReason: jest.fn(() => 'generic_error'),
}));
jest.mock('../../services/creditService', () => ({ refundCredits: jest.fn() }));
jest.mock('../../services/apnsService', () => ({ sendGenerationComplete: jest.fn() }));
jest.mock('../../db/client', () => ({ db: { execute: jest.fn() } }));

import { archiveToR2 } from '../../services/archivalService';
import { refundCredits } from '../../services/creditService';
import { markCompleted, markFailed, markQuarantined } from '../../services/generationService';
import { scanForCsam } from '../../services/hiveService';
import { falRunImageBackgroundRemoval } from '../../services/providers/FalProvider';
import { processFalImageTool } from '../../queue/falImageToolWorker';
import { hiveScanQueue } from '../../queue/hiveScanWorker';
import type { FalImageToolJob } from '../../queue/falImageToolQueue';

const JOB: FalImageToolJob = {
  kind: 'remove-background',
  generationId: 'gen-bg-1',
  userId: 'user-1',
  cost: 2,
  sourceImage: 'https://r2.example.com/source.png',
};

beforeEach(() => {
  jest.clearAllMocks();
  (markCompleted as jest.Mock).mockResolvedValue(true);
  (markFailed as jest.Mock).mockResolvedValue(true);
  (markQuarantined as jest.Mock).mockResolvedValue(true);
  (refundCredits as jest.Mock).mockResolvedValue(undefined);
});

describe('processFalImageTool', () => {
  it('archives the expiring PNG and completes without an output scan', async () => {
    (falRunImageBackgroundRemoval as jest.Mock).mockResolvedValue('https://fal.media/cutout.png');
    (archiveToR2 as jest.Mock).mockResolvedValue('generations/gen-bg-1.png');
    (scanForCsam as jest.Mock).mockResolvedValue({ flagged: false });

    await processFalImageTool(JOB);

    expect(falRunImageBackgroundRemoval).toHaveBeenCalledWith(JOB.sourceImage);
    expect(archiveToR2).toHaveBeenCalledWith(
      'https://fal.media/cutout.png',
      'gen-bg-1',
      'image/png',
    );
    expect(scanForCsam).not.toHaveBeenCalled();
    expect(markCompleted).toHaveBeenCalledWith('gen-bg-1', 'generations/gen-bg-1.png');
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it('marks failed and refunds when provider or archival fails', async () => {
    (falRunImageBackgroundRemoval as jest.Mock).mockRejectedValue(new Error('Fal 503'));

    await processFalImageTool(JOB);

    expect(markFailed).toHaveBeenCalledWith('gen-bg-1', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith('user-1', 2, 'dispatch-failure-gen-bg-1');
    expect(archiveToR2).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it('does not let a stale Hive mock block the non-real-face background-removal path', async () => {
    (falRunImageBackgroundRemoval as jest.Mock).mockResolvedValue('https://fal.media/cutout.png');
    (archiveToR2 as jest.Mock).mockResolvedValue('generations/gen-bg-1.png');
    (scanForCsam as jest.Mock).mockResolvedValue({ flagged: true });

    await processFalImageTool(JOB);

    expect(scanForCsam).not.toHaveBeenCalled();
    expect(markQuarantined).not.toHaveBeenCalled();
    expect(markCompleted).toHaveBeenCalledWith('gen-bg-1', 'generations/gen-bg-1.png');
    expect(refundCredits).not.toHaveBeenCalled();
  });
});
