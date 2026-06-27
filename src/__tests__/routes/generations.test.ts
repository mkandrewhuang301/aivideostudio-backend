// src/__tests__/routes/generations.test.ts
// Integration tests for POST /api/generations.
// Covers SC-1 (dispatch success), SC-5 (zero-credit rejection before any Replicate call),
// duration validation before credit gate, and 'auto' duration resolution never forwarding -1.

// Mock config FIRST — before any module that calls requireEnv() at load time
jest.mock('../../config', () => ({
  config: {
    revenueCatWebhookSecret: 'test-webhook-secret',
    databaseUrl: 'mock://db',
    redisUrl: 'redis://localhost',
    r2AccountId: 'mock',
    r2AccessKeyId: 'mock',
    r2SecretAccessKey: 'mock',
    r2BucketName: 'mock',
    r2PublicDomain: '',
    firebaseProjectId: 'mock',
    firebaseClientEmail: 'mock@mock.iam.gserviceaccount.com',
    firebasePrivateKey: 'mock-key',
    apnsAuthKey: 'mock-key',
    apnsKeyId: 'mock',
    apnsTeamId: 'mock',
    apnsBundleId: 'mock',
    replicateApiToken: 'mock-token',
    replicateWebhookSecret: 'whsec_mock',
    publicBaseUrl: 'https://mock.example.com',
    port: 3000,
    nodeEnv: 'test',
  },
}));

jest.mock('../../db/client', () => ({
  db: {
    execute: jest.fn(),
    insert: jest.fn(),
  },
}));

jest.mock('../../services/creditService', () => ({
  deductCredits: jest.fn(),
  refundCredits: jest.fn(),
}));

jest.mock('../../services/generationService', () => ({
  resolveDurationSeconds: jest.fn(),
  computeCostCredits: jest.fn(),
  createGeneration: jest.fn(),
  attachPredictionId: jest.fn(),
  markRefunded: jest.fn(),
  SUPPORTED_MODELS: ['bytedance/seedance-2.0-fast', 'bytedance/seedance-2.0-mini'],
}));

jest.mock('../../services/providers/ReplicateProvider', () => {
  return {
    ReplicateProvider: jest.fn().mockImplementation(() => ({
      dispatch: jest.fn(),
    })),
  };
});

// Mock promptModerationMiddleware as a pass-through — moderation logic is tested separately
// in src/__tests__/middleware/promptModeration.test.ts
jest.mock('../../middleware/promptModeration', () => ({
  promptModerationMiddleware: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { generationsRouter } from '../../routes/generations';
import { deductCredits } from '../../services/creditService';
import {
  resolveDurationSeconds,
  computeCostCredits,
  createGeneration,
  attachPredictionId,
} from '../../services/generationService';
import { ReplicateProvider } from '../../services/providers/ReplicateProvider';

// Grab the mocked dispatch fn off the mocked class's first (and only) instance used by the router.
// generationsRouter does `const provider = new ReplicateProvider();` at module load time,
// so the mock constructor was already invoked once; pull the instance's dispatch mock from
// the mock's `.mock.results`.
const MockedReplicateProvider = ReplicateProvider as jest.MockedClass<typeof ReplicateProvider>;
const providerInstance = MockedReplicateProvider.mock.results[0]?.value as { dispatch: jest.Mock };
const dispatchMock = providerInstance.dispatch;

const app = express();
app.use(express.json());

// Fake auth-injecting middleware mirroring authMiddleware's effect on req.user
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.user = { dbUserId: 'test-user-id', uid: 'fb-uid', email: 't@test.com' };
  next();
});

app.use('/api/generations', generationsRouter);

const VALID_BODY = {
  prompt: 'a cinematic shot of a city at night',
  duration: 8,
  resolution: '720p' as const,
  aspect_ratio: '16:9',
  audio_enabled: false,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/generations', () => {
  it('Test 1: dispatches and returns 200 with generation_id + processing on success', async () => {
    (resolveDurationSeconds as jest.Mock).mockReturnValue(8);
    (computeCostCredits as jest.Mock).mockReturnValue(60);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-123' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-abc' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generation_id: 'gen-123', status: 'processing' });

    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', cost_credits: 60 }),
    );
    expect(deductCredits).toHaveBeenCalledWith('test-user-id', 60);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(attachPredictionId).toHaveBeenCalledWith('gen-123', 'pred-abc');
  });

  it('Test 2: insufficient credits returns 402 and never calls ReplicateProvider.dispatch', async () => {
    (resolveDurationSeconds as jest.Mock).mockReturnValue(8);
    (computeCostCredits as jest.Mock).mockReturnValue(60);
    (deductCredits as jest.Mock).mockResolvedValue(false);

    const res = await request(app).post('/api/generations').send(VALID_BODY);

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
  });

  it('Test 3: out-of-range duration returns 400 before credit deduction is attempted', async () => {
    (resolveDurationSeconds as jest.Mock).mockImplementation(() => {
      throw new Error('duration must be an integer between 4 and 15 seconds');
    });

    const res = await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, duration: 20 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DURATION');
    expect(deductCredits).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("Test 4: duration 'auto' resolves to explicit seconds, never -1, in DB insert and dispatch input", async () => {
    (resolveDurationSeconds as jest.Mock).mockReturnValue(5);
    (computeCostCredits as jest.Mock).mockReturnValue(38);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-456' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-def' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, duration: 'auto' });

    expect(res.status).toBe(200);
    expect(resolveDurationSeconds).toHaveBeenCalledWith('auto');
    expect(computeCostCredits).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 5 }),
    );

    const createGenerationArg = (createGeneration as jest.Mock).mock.calls[0][0];
    expect(createGenerationArg.params.duration).toBe(5);
    expect(createGenerationArg.params.duration).not.toBe(-1);

    const dispatchInputArg = dispatchMock.mock.calls[0][0];
    expect(dispatchInputArg.durationSeconds).toBe(5);
    expect(dispatchInputArg.durationSeconds).not.toBe(-1);
  });
});
