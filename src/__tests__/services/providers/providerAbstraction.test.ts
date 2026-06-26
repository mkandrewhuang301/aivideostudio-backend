// src/__tests__/services/providers/providerAbstraction.test.ts
// Verifies: (1) ModelProvider interface is substitutable by a second implementation with zero
// interface changes (SC-3), (2) ReplicateProvider.dispatch() never forwards duration: -1 and
// uses the exact model string + webhook_events_filter, (3) ReplicateProvider.getStatus() maps
// array/string output correctly.

jest.mock('../../../config', () => ({
  config: {
    replicateApiToken: 'fake-replicate-token',
    replicateWebhookSecret: 'whsec_fake',
  },
}));

const mockCreate = jest.fn();
const mockGet = jest.fn();

class MockReplicate {
  predictions: { create: jest.Mock; get: jest.Mock };
  constructor() {
    this.predictions = { create: mockCreate, get: mockGet };
  }
}

jest.mock('replicate', () => ({
  __esModule: true,
  default: MockReplicate,
}));

import { ReplicateProvider } from '../../../services/providers/ReplicateProvider';
import type {
  ModelProvider,
  GenerationInput,
  DispatchResult,
  PredictionStatus,
} from '../../../services/providers/ModelProvider';

describe('ModelProvider substitutability (SC-3)', () => {
  it('a FakeProvider implementing ModelProvider compiles and satisfies the interface with no changes', async () => {
    class FakeProvider implements ModelProvider {
      async dispatch(_input: GenerationInput, _webhookUrl: string): Promise<DispatchResult> {
        return { providerPredictionId: 'fake-prediction-id' };
      }
      async getStatus(_providerPredictionId: string): Promise<PredictionStatus> {
        return { status: 'succeeded', outputUrl: 'https://example.com/fake.mp4' };
      }
    }

    const fake: ModelProvider = new FakeProvider();
    const dispatchResult = await fake.dispatch(
      {
        prompt: 'a cat',
        durationSeconds: 5,
        resolution: '720p',
        aspectRatio: '16:9',
        audioEnabled: false,
      },
      'https://example.com/webhook',
    );
    expect(dispatchResult).toEqual({ providerPredictionId: 'fake-prediction-id' });

    const status = await fake.getStatus('fake-prediction-id');
    expect(status.status).toBe('succeeded');
  });
});

describe('ReplicateProvider.dispatch', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockGet.mockReset();
  });

  it('calls predictions.create with exact model string, webhook_events_filter, and never forwards duration: -1', async () => {
    mockCreate.mockResolvedValue({ id: 'pred-123' });

    const provider = new ReplicateProvider();
    const input: GenerationInput = {
      prompt: 'a dog running',
      durationSeconds: 8,
      resolution: '720p',
      aspectRatio: '16:9',
      audioEnabled: true,
    };

    const result = await provider.dispatch(input, 'https://example.com/webhooks/replicate');

    expect(result).toEqual({ providerPredictionId: 'pred-123' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('bytedance/seedance-2.0-fast');
    expect(callArgs.webhook_events_filter).toEqual(['completed']);
    expect(callArgs.webhook).toBe('https://example.com/webhooks/replicate');
    expect(callArgs.input.duration).toBe(8);
    expect(Number.isInteger(callArgs.input.duration)).toBe(true);
    expect(callArgs.input.duration).toBeGreaterThan(0);
    expect(callArgs.input.duration).not.toBe(-1);
  });
});

describe('ReplicateProvider.getStatus', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockGet.mockReset();
  });

  it('maps array output to outputUrl (first element)', async () => {
    mockGet.mockResolvedValue({
      status: 'succeeded',
      output: ['https://replicate.delivery/output1.mp4', 'https://replicate.delivery/output2.mp4'],
      error: null,
    });

    const provider = new ReplicateProvider();
    const status = await provider.getStatus('pred-123');

    expect(mockGet).toHaveBeenCalledWith('pred-123');
    expect(status.status).toBe('succeeded');
    expect(status.outputUrl).toBe('https://replicate.delivery/output1.mp4');
    expect(status.error).toBeUndefined();
  });

  it('maps string output to outputUrl directly', async () => {
    mockGet.mockResolvedValue({
      status: 'succeeded',
      output: 'https://replicate.delivery/single.mp4',
      error: null,
    });

    const provider = new ReplicateProvider();
    const status = await provider.getStatus('pred-456');

    expect(status.outputUrl).toBe('https://replicate.delivery/single.mp4');
  });
});
