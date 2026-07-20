// src/__tests__/queue/chainGenerationWorker.test.ts
// Tests for processChainGeneration (the chained-job primitive's background job handler, 09.6-05).
// UVU is the sole 9.6 consumer — exercised here via a 2-prompt UVU-shape fixture so Plan 06's
// registry row is a pure data drop. No live Redis required — BullMQ is mocked; logic is tested via
// the exported processor function, mirroring openaiGenerationWorker.test.ts's approach.

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
    hiveScanRealFacePaths: true,
  },
  getReplicateWebhookUrl: jest.fn(() => 'https://mock.example.com/webhooks/replicate'),
}));

jest.mock('../../services/providers/ReplicateProvider', () => ({
  generateKeyframeFromPhotos: jest.fn(),
  ReplicateProvider: jest.fn().mockImplementation(() => ({
    dispatch: jest.fn(),
  })),
}));

jest.mock('../../services/archivalService', () => ({
  getGenerationPresignedUrl: jest.fn(),
}));

jest.mock('../../services/generationService', () => ({
  attachPredictionId: jest.fn(),
  markFailed: jest.fn(),
  // Fully mocked (not requireActual) — avoids pulling in db/client, which connects to Neon at
  // module load time. This job's dispatch-throw fixture classifies as 'generic_error' anyway.
  classifyFailureReason: jest.fn(() => 'generic_error'),
}));

jest.mock('../../services/creditService', () => ({ refundCredits: jest.fn() }));

import { generateKeyframeFromPhotos, ReplicateProvider } from '../../services/providers/ReplicateProvider';
import { getGenerationPresignedUrl } from '../../services/archivalService';
import { attachPredictionId, markFailed } from '../../services/generationService';
import { refundCredits } from '../../services/creditService';
import { processChainGeneration } from '../../queue/chainGenerationWorker';
import type { ChainGenerationJob } from '../../queue/chainGenerationQueue';

const MockedReplicateProvider = ReplicateProvider as jest.MockedClass<typeof ReplicateProvider>;
const providerInstance = MockedReplicateProvider.mock.results[0]?.value as { dispatch: jest.Mock };
const dispatchMock = providerInstance.dispatch;

// UVU shape: 2 keyframe prompts (current-you arena walk-in, young-you spotlight reveal) feeding
// a single HappyHorse animate stage.
const UVU_JOB: ChainGenerationJob = {
  generationId: 'gen-chain-1',
  userId: 'user-1',
  cost: 30,
  userPhotoUrls: ['https://r2.example.com/user-photo.jpg'],
  imageStage: {
    model: 'wan-video/wan-2.7-image',
    quality: 'high',
    prompts: ['current-you walking into the dark arena', 'young-you under the spotlight'],
  },
  animateStage: {
    model: 'alibaba/happyhorse-1.1',
    resolution: '720p',
    duration: 8,
    aspect_ratio: '9:16',
    prompt_template: 'the first image is the opening, the second image is the ending reveal',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  (attachPredictionId as jest.Mock).mockResolvedValue(undefined);
  (markFailed as jest.Mock).mockResolvedValue(true);
  (refundCredits as jest.Mock).mockResolvedValue(undefined);
});

describe('processChainGeneration — UVU (2-prompt) shape', () => {
  it('composes 2 keyframes, dispatches HappyHorse once with both as referenceImages, attaches prediction id, no markFailed/refund', async () => {
    (generateKeyframeFromPhotos as jest.Mock)
      .mockResolvedValueOnce('generations/gen-chain-1.keyframe0.png')
      .mockResolvedValueOnce('generations/gen-chain-1.keyframe1.png');
    (getGenerationPresignedUrl as jest.Mock)
      .mockResolvedValueOnce('https://r2.example.com/keyframe0-signed')
      .mockResolvedValueOnce('https://r2.example.com/keyframe1-signed');
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-happyhorse-1' });

    await processChainGeneration(UVU_JOB);

    expect(generateKeyframeFromPhotos).toHaveBeenCalledTimes(2);
    expect(generateKeyframeFromPhotos).toHaveBeenNthCalledWith(
      1,
      ['https://r2.example.com/user-photo.jpg'],
      'current-you walking into the dark arena',
      'gen-chain-1.keyframe0',
    );
    expect(generateKeyframeFromPhotos).toHaveBeenNthCalledWith(
      2,
      ['https://r2.example.com/user-photo.jpg'],
      'young-you under the spotlight',
      'gen-chain-1.keyframe1',
    );

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [input] = dispatchMock.mock.calls[0]!;
    expect(input.model).toBe('alibaba/happyhorse-1.1');
    expect(input.mediaType).toBe('video');
    expect(input.referenceImages).toEqual([
      'https://r2.example.com/keyframe0-signed',
      'https://r2.example.com/keyframe1-signed',
    ]);
    expect(input.referenceImages).toHaveLength(2);
    expect(input.durationSeconds).toBe(8);
    expect(input.resolution).toBe('720p');
    expect(input.aspectRatio).toBe('9:16');
    expect(input.audioEnabled).toBe(true);
    expect(input.prompt).toBe('the first image is the opening, the second image is the ending reveal');

    expect(attachPredictionId).toHaveBeenCalledWith('gen-chain-1', 'pred-happyhorse-1');
    expect(markFailed).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it('Stage 1 throw (keyframe compositor) → markFailed + refundCredits, no dispatch, no attach', async () => {
    (generateKeyframeFromPhotos as jest.Mock).mockRejectedValue(new Error('Wan 2.7 Image failed'));

    await processChainGeneration(UVU_JOB);

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(attachPredictionId).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith('gen-chain-1', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith('user-1', 30, 'chain-failure-gen-chain-1');
  });

  it('Stage 2 dispatch throw (HappyHorse) → markFailed + refundCredits, no attach', async () => {
    (generateKeyframeFromPhotos as jest.Mock)
      .mockResolvedValueOnce('generations/gen-chain-1.keyframe0.png')
      .mockResolvedValueOnce('generations/gen-chain-1.keyframe1.png');
    (getGenerationPresignedUrl as jest.Mock)
      .mockResolvedValueOnce('https://r2.example.com/keyframe0-signed')
      .mockResolvedValueOnce('https://r2.example.com/keyframe1-signed');
    dispatchMock.mockRejectedValue(new Error('Replicate dispatch failed'));

    await processChainGeneration(UVU_JOB);

    expect(attachPredictionId).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith('gen-chain-1', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith('user-1', 30, 'chain-failure-gen-chain-1');
  });
});
