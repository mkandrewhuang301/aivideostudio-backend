const submitMock = jest.fn();
const statusMock = jest.fn();
const resultMock = jest.fn();

jest.mock('@fal-ai/client', () => ({
  fal: {
    queue: {
      submit: submitMock,
      status: statusMock,
      result: resultMock,
    },
  },
  ApiError: class ApiError extends Error {
    status = 500;
  },
}));

import {
  FalProvider,
  FAL_KLING_V3_STANDARD_I2V_MODEL,
  encodePredictionId,
} from '../../services/providers/FalProvider';

describe('FalProvider — Kling v3 Standard image-to-video', () => {
  beforeEach(() => jest.clearAllMocks());

  it('maps the app contract to the live fal input field names', async () => {
    submitMock.mockResolvedValue({ request_id: 'req-kling-1' });
    const provider = new FalProvider();

    const result = await provider.dispatch({
      prompt: 'camera slowly pushes in',
      model: FAL_KLING_V3_STANDARD_I2V_MODEL,
      mediaType: 'video',
      durationSeconds: 5,
      audioEnabled: false,
      referenceImages: ['https://r2.example.com/start.png'],
    }, 'https://api.example.com/webhooks/fal');

    expect(submitMock).toHaveBeenCalledWith(FAL_KLING_V3_STANDARD_I2V_MODEL, {
      input: {
        start_image_url: 'https://r2.example.com/start.png',
        duration: '5',
        generate_audio: false,
        prompt: 'camera slowly pushes in',
      },
      webhookUrl: 'https://api.example.com/webhooks/fal',
    });
    expect(result.providerPredictionId).toBe(
      `${FAL_KLING_V3_STANDARD_I2V_MODEL}::req-kling-1`,
    );
  });

  it('rejects Motion Control so it cannot accidentally move off Replicate again', async () => {
    const provider = new FalProvider();
    await expect(provider.dispatch({
      prompt: '',
      model: 'kwaivgi/kling-v3-motion-control',
      mediaType: 'video',
      durationSeconds: 5,
      referenceImages: ['https://r2.example.com/start.png'],
    }, 'https://api.example.com/webhooks/fal')).rejects.toThrow(/does not support/);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('polls the encoded endpoint and extracts video.url on completion', async () => {
    statusMock.mockResolvedValue({ status: 'COMPLETED' });
    resultMock.mockResolvedValue({ data: { video: { url: 'https://fal.media/out.mp4' } } });
    const provider = new FalProvider();

    await expect(provider.getStatus(
      encodePredictionId(FAL_KLING_V3_STANDARD_I2V_MODEL, 'req-kling-2'),
    )).resolves.toEqual({ status: 'succeeded', outputUrl: 'https://fal.media/out.mp4' });
  });

  it('rejects an encoded endpoint outside the provider allowlist', async () => {
    const provider = new FalProvider();
    await expect(provider.getStatus('fal-ai/other-model::req-3')).rejects.toThrow(/Unsupported Fal endpoint/);
    expect(statusMock).not.toHaveBeenCalled();
  });
});
