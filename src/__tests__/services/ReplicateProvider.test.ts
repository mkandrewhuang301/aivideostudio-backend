// src/__tests__/services/ReplicateProvider.test.ts
// Kling v3 motion control (kwaivgi/kling-v3-motion-control) dispatch-branch unit test.
// Plan 09.6-03: standalone provider-layer integration — no 9.6 preset wires these fields yet.
// Pins the LIVE-verified input field names (image, video, mode) so a wrong-field-name regression
// fails loudly (T-09.6-16).

jest.mock('../../config', () => ({
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

import { ReplicateProvider } from '../../services/providers/ReplicateProvider';
import type { GenerationInput } from '../../services/providers/ModelProvider';

describe('ReplicateProvider.dispatch — kling-v3-motion-control', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockGet.mockReset();
  });

  it('dispatches kling-v3-motion-control with the live-verified image/video/mode input keys', async () => {
    mockCreate.mockResolvedValue({ id: 'pred_1' });

    const provider = new ReplicateProvider();
    const input: GenerationInput = {
      prompt: '',
      model: 'kwaivgi/kling-v3-motion-control',
      klingMotionImage: 'https://r2.example.com/character.jpg',
      klingMotionVideo: 'https://r2.example.com/driver.mp4',
      klingMotionMode: 'std',
    };

    const result = await provider.dispatch(input, 'https://example.com/webhooks/replicate');

    expect(result).toEqual({ providerPredictionId: 'pred_1' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('kwaivgi/kling-v3-motion-control');
    expect(callArgs.webhook_events_filter).toEqual(['completed']);
    expect(callArgs.input.image).toBe('https://r2.example.com/character.jpg');
    expect(callArgs.input.video).toBe('https://r2.example.com/driver.mp4');
    expect(callArgs.input.mode).toBe('std');
  });
});
