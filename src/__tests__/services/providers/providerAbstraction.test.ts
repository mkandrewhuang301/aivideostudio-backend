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
        model: 'bytedance/seedance-2.0-fast',
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
      model: 'bytedance/seedance-2.0-fast',
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

describe('ReplicateProvider.dispatch — image models', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockGet.mockReset();
  });

  it('Seedream image dispatch sends prompt + aspect_ratio only — no size parameter', async () => {
    mockCreate.mockResolvedValue({ id: 'pred-img-1' });

    const provider = new ReplicateProvider();
    const result = await provider.dispatch(
      {
        prompt: 'a fox in a forest',
        model: 'bytedance/seedream-5-lite',
        mediaType: 'image',
        imageAspectRatio: '16:9',
      },
      'https://example.com/webhooks/replicate',
    );

    expect(result).toEqual({ providerPredictionId: 'pred-img-1' });
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('bytedance/seedream-5-lite');
    expect(callArgs.input.prompt).toBe('a fox in a forest');
    expect(callArgs.input.aspect_ratio).toBe('16:9');
    // No size parameter — it was removed because it caused Replicate validation errors
    expect(callArgs.input.size).toBeUndefined();
    expect(callArgs.webhook_events_filter).toEqual(['completed']);
  });

  it('Seedream image dispatch defaults aspect_ratio to 1:1 when imageAspectRatio is omitted', async () => {
    mockCreate.mockResolvedValue({ id: 'pred-img-2' });

    const provider = new ReplicateProvider();
    await provider.dispatch(
      { prompt: 'a cat', model: 'bytedance/seedream-4.5', mediaType: 'image' },
      'https://example.com/webhooks/replicate',
    );

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.input.aspect_ratio).toBe('1:1');
    expect(callArgs.input.size).toBeUndefined();
  });
});

describe('ReplicateProvider.dispatch — xAI Grok Imagine Video 1.5', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockGet.mockReset();
  });

  it('sends a single image field and never a generate_audio or reference_images key', async () => {
    mockCreate.mockResolvedValue({ id: 'pred-grok-1' });

    const provider = new ReplicateProvider();
    await provider.dispatch(
      {
        prompt: 'the woman looks up into the sunlight',
        model: 'xai/grok-imagine-video-1.5',
        mediaType: 'video',
        durationSeconds: 5,
        resolution: '720p',
        aspectRatio: '16:9',
        audioEnabled: true,
        referenceImages: ['https://example.com/source.png'],
      },
      'https://example.com/webhooks/replicate',
    );

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('xai/grok-imagine-video-1.5');
    expect(callArgs.input.image).toBe('https://example.com/source.png');
    expect(callArgs.input.duration).toBe(5);
    expect(callArgs.input.resolution).toBe('720p');
    expect(callArgs.input.aspect_ratio).toBe('16:9');
    expect(callArgs.input.generate_audio).toBeUndefined();
    expect(callArgs.input.reference_images).toBeUndefined();
    expect(callArgs.input.reference_videos).toBeUndefined();
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
