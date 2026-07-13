// src/__tests__/queue/influencerProWorker.test.ts
// Tests for processInfluencerProGeneration — AI Influencer Pro tier's 3-step pipeline (frame
// extract -> Wan 2.7 composite -> Kling v3 Motion Control). No live Redis/ffmpeg/Replicate
// required — every stage's dependency is mocked; logic is tested via the exported processor
// function, mirroring chainGenerationWorker.test.ts's approach.

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
    hiveScanEnabled: true,
  },
  getReplicateWebhookUrl: jest.fn(() => 'https://mock.example.com/webhooks/replicate'),
}));

jest.mock('../../services/frameExtractor', () => ({
  extractVideoFrame: jest.fn(),
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
  classifyFailureReason: jest.fn(() => 'generic_error'),
}));

jest.mock('../../services/creditService', () => ({ refundCredits: jest.fn() }));

import { extractVideoFrame } from '../../services/frameExtractor';
import { generateKeyframeFromPhotos, ReplicateProvider } from '../../services/providers/ReplicateProvider';
import { getGenerationPresignedUrl } from '../../services/archivalService';
import { attachPredictionId, markFailed } from '../../services/generationService';
import { refundCredits } from '../../services/creditService';
import { processInfluencerProGeneration } from '../../queue/influencerProWorker';
import type { InfluencerProGenerationJob } from '../../queue/influencerProQueue';

const MockedReplicateProvider = ReplicateProvider as jest.MockedClass<typeof ReplicateProvider>;
const providerInstance = MockedReplicateProvider.mock.results[0]?.value as { dispatch: jest.Mock };
const dispatchMock = providerInstance.dispatch;

const JOB: InfluencerProGenerationJob = {
  generationId: 'gen-influencer-pro-1',
  userId: 'user-1',
  cost: 87,
  characterImageUrl: 'https://r2.example.com/character-signed',
  sourceVideoUrl: 'https://r2.example.com/source-video-signed',
};

beforeEach(() => {
  jest.clearAllMocks();
  (attachPredictionId as jest.Mock).mockResolvedValue(undefined);
  (markFailed as jest.Mock).mockResolvedValue(true);
  (refundCredits as jest.Mock).mockResolvedValue(undefined);
});

describe('processInfluencerProGeneration', () => {
  it('extracts a frame, composites with Wan 2.7, dispatches Kling v3 std against the ORIGINAL video, attaches prediction id', async () => {
    (extractVideoFrame as jest.Mock).mockResolvedValue('generations/gen-influencer-pro-1.frame.png');
    (generateKeyframeFromPhotos as jest.Mock).mockResolvedValue('generations/gen-influencer-pro-1.composite.png');
    (getGenerationPresignedUrl as jest.Mock)
      .mockResolvedValueOnce('https://r2.example.com/frame-signed')
      .mockResolvedValueOnce('https://r2.example.com/composite-signed');
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-kling-1' });

    await processInfluencerProGeneration(JOB);

    expect(extractVideoFrame).toHaveBeenCalledWith(
      'https://r2.example.com/source-video-signed',
      'gen-influencer-pro-1.frame',
      0.5,
    );
    expect(generateKeyframeFromPhotos).toHaveBeenCalledWith(
      ['https://r2.example.com/character-signed', 'https://r2.example.com/frame-signed'],
      expect.stringContaining('Reference Image 1'),
      'gen-influencer-pro-1.composite',
    );

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [input] = dispatchMock.mock.calls[0]!;
    expect(input.model).toBe('kwaivgi/kling-v3-motion-control');
    // mediaType deliberately 'video', not 'character_replace' — ReplicateProvider branches on
    // mediaType before its model-id checks, and 'character_replace' would misroute this into the
    // Wan 2.2 Animate Replace payload shape instead of Kling's.
    expect(input.mediaType).toBe('video');
    expect(input.klingMotionImage).toBe('https://r2.example.com/composite-signed');
    // The ORIGINAL video, not the extracted frame — Kling needs the full motion source.
    expect(input.klingMotionVideo).toBe('https://r2.example.com/source-video-signed');
    // 'std', not 'pro' — this preset's "Pro" tier is the compositing pipeline itself, not
    // Kling's own internal quality flag (2026-07-13, user-clarified).
    expect(input.klingMotionMode).toBe('std');
    expect(input.klingMotionCharacterOrientation).toBe('video');
    expect(input.klingMotionKeepOriginalSound).toBe(true);

    expect(attachPredictionId).toHaveBeenCalledWith('gen-influencer-pro-1', 'pred-kling-1');
    expect(markFailed).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it('Stage 1 throw (frame extract) → markFailed + refundCredits, no composite/dispatch/attach', async () => {
    (extractVideoFrame as jest.Mock).mockRejectedValue(new Error('ffmpeg failed'));

    await processInfluencerProGeneration(JOB);

    expect(generateKeyframeFromPhotos).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(attachPredictionId).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith('gen-influencer-pro-1', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith('user-1', 87, 'influencer-pro-failure-gen-influencer-pro-1');
  });

  it('Stage 2 throw (Wan 2.7 composite) → markFailed + refundCredits, no dispatch/attach', async () => {
    (extractVideoFrame as jest.Mock).mockResolvedValue('generations/gen-influencer-pro-1.frame.png');
    (getGenerationPresignedUrl as jest.Mock).mockResolvedValueOnce('https://r2.example.com/frame-signed');
    (generateKeyframeFromPhotos as jest.Mock).mockRejectedValue(new Error('Wan 2.7 Image failed'));

    await processInfluencerProGeneration(JOB);

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(attachPredictionId).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith('gen-influencer-pro-1', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith('user-1', 87, 'influencer-pro-failure-gen-influencer-pro-1');
  });

  it('Stage 3 throw (Kling dispatch) → markFailed + refundCredits, no attach', async () => {
    (extractVideoFrame as jest.Mock).mockResolvedValue('generations/gen-influencer-pro-1.frame.png');
    (generateKeyframeFromPhotos as jest.Mock).mockResolvedValue('generations/gen-influencer-pro-1.composite.png');
    (getGenerationPresignedUrl as jest.Mock)
      .mockResolvedValueOnce('https://r2.example.com/frame-signed')
      .mockResolvedValueOnce('https://r2.example.com/composite-signed');
    dispatchMock.mockRejectedValue(new Error('Replicate dispatch failed'));

    await processInfluencerProGeneration(JOB);

    expect(attachPredictionId).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith('gen-influencer-pro-1', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith('user-1', 87, 'influencer-pro-failure-gen-influencer-pro-1');
  });
});
