// src/__tests__/queue/openaiGenerationWorker.test.ts
// Tests for processOpenAIGeneration (the background job handler for faceswap + Magic Editor).
// No live Redis required — BullMQ is mocked; logic is tested via the exported processor function.
// Mirrors hiveScanWorker.test.ts's mocking approach.

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
    hiveApiKey: 'mock-hive-key', openaiApiKey: 'mock-openai-key',
    publicBaseUrl: 'https://mock.example.com',
    port: 3000, nodeEnv: 'test',
    // Default ON so the CSAM-scan branch is exercised; individual tests can't flip this per-case,
    // so the "hive disabled" behavior is not separately covered here (it just skips the scan).
    hiveScanRealFacePaths: true,
  },
}));

jest.mock('../../services/openaiImageService', () => ({
  generateFaceswap: jest.fn(),
  generateImageEditWithMask: jest.fn(),
}));
jest.mock('../../services/hiveService', () => ({ scanForCsam: jest.fn() }));
jest.mock('../../services/generationService', () => ({
  getOutputModerationContext: jest.fn(),
  markCompleted: jest.fn(),
  markFailed: jest.fn(),
  markQuarantined: jest.fn(),
  // Fully mocked (not requireActual) — the real module imports db/client which connects to Neon
  // at load time. These job payloads all classify as 'generic_error' anyway.
  classifyFailureReason: jest.fn(() => 'generic_error'),
}));
jest.mock('../../services/moderationEnforcementService', () => ({
  enforceFlaggedGeneration: jest.fn(),
}));
jest.mock('../../services/creditService', () => ({ refundCredits: jest.fn() }));

// D-E guard: this module must NEVER reap raw face uploads. Mock it so we can assert it's not called.
jest.mock('../../services/uploadCleanup', () => ({ deleteRawFaceUploads: jest.fn() }));

// openaiGenerationWorker now imports hiveScanQueue from hiveScanWorker.ts (the Hive-error-retry
// fix) — that module also imports apnsService + db/client, which need the same mocks
// hiveScanWorker.test.ts already uses, or module load would try a real Neon connection.
jest.mock('../../services/apnsService', () => ({ sendGenerationComplete: jest.fn() }));
jest.mock('../../db/client', () => ({ db: { execute: jest.fn() } }));

import { generateFaceswap, generateImageEditWithMask } from '../../services/openaiImageService';
import { scanForCsam } from '../../services/hiveService';
import { getOutputModerationContext, markCompleted, markFailed, markQuarantined } from '../../services/generationService';
import { refundCredits } from '../../services/creditService';
import { deleteRawFaceUploads } from '../../services/uploadCleanup';
import { processOpenAIGeneration } from '../../queue/openaiGenerationWorker';
import { hiveScanQueue } from '../../queue/hiveScanWorker';
import type { OpenAIGenerationJob } from '../../queue/openaiGenerationQueue';
import { enforceFlaggedGeneration } from '../../services/moderationEnforcementService';

const FACESWAP_JOB: OpenAIGenerationJob = {
  kind: 'faceswap',
  generationId: 'gen-fs-1',
  userId: 'user-1',
  cost: 5,
  targetImage: 'https://r2.example.com/target.png',
  faceImage: 'https://r2.example.com/face.png',
};

const MAGIC_JOB: OpenAIGenerationJob = {
  kind: 'magic-editor',
  generationId: 'gen-me-1',
  userId: 'user-1',
  cost: 5,
  sourceImage: 'https://r2.example.com/source.png',
  maskUrl: 'https://r2.example.com/mask.png',
  prompt: 'make the sky purple',
};

beforeEach(() => {
  jest.clearAllMocks();
  (markCompleted as jest.Mock).mockResolvedValue(true);
  (markFailed as jest.Mock).mockResolvedValue(true);
  (markQuarantined as jest.Mock).mockResolvedValue(true);
  (refundCredits as jest.Mock).mockResolvedValue(undefined);
  (getOutputModerationContext as jest.Mock).mockImplementation(async (generationId: string) => ({
    generationId,
    userId: 'user-1',
    hasRealFaceInput: generationId === 'gen-fs-1',
    status: 'processing',
  }));
});

describe('processOpenAIGeneration — faceswap', () => {
  it('calls generateFaceswap(target, face, id) then markCompleted, no refund, no deletion', async () => {
    (generateFaceswap as jest.Mock).mockResolvedValue('generations/gen-fs-1.png');
    (scanForCsam as jest.Mock).mockResolvedValue({ flagged: false });

    await processOpenAIGeneration(FACESWAP_JOB);

    // Image order is load-bearing: targetImage first, faceImage second.
    expect(generateFaceswap).toHaveBeenCalledWith(
      'https://r2.example.com/target.png',
      'https://r2.example.com/face.png',
      'gen-fs-1',
    );
    expect(markCompleted).toHaveBeenCalledWith('gen-fs-1', 'generations/gen-fs-1.png');
    expect(refundCredits).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(markQuarantined).not.toHaveBeenCalled();
    // D-E: faceswap uploads are retained — never reaped by this worker.
    expect(deleteRawFaceUploads).not.toHaveBeenCalled();
  });

  it('OpenAI throws → markFailed + refundCredits, never markCompleted', async () => {
    (generateFaceswap as jest.Mock).mockRejectedValue(new Error('OpenAI 429 rate limit'));

    await processOpenAIGeneration(FACESWAP_JOB);

    expect(markFailed).toHaveBeenCalledWith('gen-fs-1', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith('user-1', 5, 'dispatch-failure-gen-fs-1');
    expect(markCompleted).not.toHaveBeenCalled();
    expect(deleteRawFaceUploads).not.toHaveBeenCalled();
  });

  it('flagged faceswap output is routed through two-tier enforcement', async () => {
    (generateFaceswap as jest.Mock).mockResolvedValue('generations/gen-fs-1.png');
    const result = { flagged: true, tier: 'high', childScore: 0.95, sexualScore: 0.9, hashMatched: false };
    (scanForCsam as jest.Mock).mockResolvedValue(result);

    await processOpenAIGeneration(FACESWAP_JOB);

    expect(enforceFlaggedGeneration).toHaveBeenCalledWith({
      generationId: 'gen-fs-1',
      r2Key: 'generations/gen-fs-1.png',
      userId: 'user-1',
      costCredits: 5,
    }, result);
    expect(markCompleted).not.toHaveBeenCalled();
    expect(deleteRawFaceUploads).not.toHaveBeenCalled();
  });

  it('Hive scan error → queues a retry via hiveScanQueue, never markCompleted (CLAUDE.md Rule 4: no unscanned content shipped)', async () => {
    (generateFaceswap as jest.Mock).mockResolvedValue('generations/gen-fs-1.png');
    (scanForCsam as jest.Mock).mockRejectedValue(new Error('Hive timeout'));

    await processOpenAIGeneration(FACESWAP_JOB);

    expect(hiveScanQueue.add).toHaveBeenCalledWith('scan', {
      generationId: 'gen-fs-1',
      r2Key: 'generations/gen-fs-1.png',
      userId: 'user-1',
      costCredits: 5,
      mediaType: 'image',
    });
    expect(markCompleted).not.toHaveBeenCalled();
    expect(markQuarantined).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });
});

describe('processOpenAIGeneration — magic-editor', () => {
  it('calls generateImageEditWithMask(source, mask, prompt, id) then markCompleted', async () => {
    (generateImageEditWithMask as jest.Mock).mockResolvedValue('generations/gen-me-1.png');
    (scanForCsam as jest.Mock).mockResolvedValue({ flagged: false });

    await processOpenAIGeneration(MAGIC_JOB);

    expect(generateImageEditWithMask).toHaveBeenCalledWith(
      'https://r2.example.com/source.png',
      'https://r2.example.com/mask.png',
      'make the sky purple',
      'gen-me-1',
    );
    expect(markCompleted).toHaveBeenCalledWith('gen-me-1', 'generations/gen-me-1.png');
    expect(scanForCsam).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
    expect(deleteRawFaceUploads).not.toHaveBeenCalled();
  });

  it('OpenAI throws → markFailed + refundCredits, never markCompleted or generateFaceswap', async () => {
    (generateImageEditWithMask as jest.Mock).mockRejectedValue(new Error('OpenAI 500'));

    await processOpenAIGeneration(MAGIC_JOB);

    expect(markFailed).toHaveBeenCalledWith('gen-me-1', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith('user-1', 5, 'dispatch-failure-gen-me-1');
    expect(markCompleted).not.toHaveBeenCalled();
    expect(generateFaceswap).not.toHaveBeenCalled();
  });
});
