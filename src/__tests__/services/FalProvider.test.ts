const submitMock = jest.fn();
const statusMock = jest.fn();
const resultMock = jest.fn();
const subscribeMock = jest.fn();

jest.mock('@fal-ai/client', () => ({
  fal: {
    subscribe: subscribeMock,
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
  FAL_IMAGE_BACKGROUND_REMOVAL_MODEL,
  FAL_KLING_V3_STANDARD_I2V_MODEL,
  FAL_VIDEO_BACKGROUND_REMOVAL_MODEL,
  encodePredictionId,
  falRunImageBackgroundRemoval,
  falRunLyria,
  falRunOmniI2v,
  falRunTts,
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

describe('FalProvider — transparent video background removal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('maps one source video to the live-verified transparent ProRes 4444 contract', async () => {
    submitMock.mockResolvedValue({ request_id: 'req-video-bg-1' });
    const provider = new FalProvider();

    const result = await provider.dispatch({
      prompt: '',
      model: FAL_VIDEO_BACKGROUND_REMOVAL_MODEL,
      mediaType: 'video',
      referenceVideos: ['https://r2.example.com/source.mp4'],
    }, 'https://api.example.com/webhooks/fal');

    expect(submitMock).toHaveBeenCalledWith(FAL_VIDEO_BACKGROUND_REMOVAL_MODEL, {
      input: {
        video_url: 'https://r2.example.com/source.mp4',
        background: 'transparent',
        output_format: 'mov_proresks',
      },
      webhookUrl: 'https://api.example.com/webhooks/fal',
    });
    expect(result.providerPredictionId).toBe(`${FAL_VIDEO_BACKGROUND_REMOVAL_MODEL}::req-video-bg-1`);
  });

  it('rejects a missing or multiple source-video contract before submit', async () => {
    const provider = new FalProvider();
    await expect(provider.dispatch({
      prompt: '',
      model: FAL_VIDEO_BACKGROUND_REMOVAL_MODEL,
      mediaType: 'video',
      referenceVideos: [],
    }, 'https://api.example.com/webhooks/fal')).rejects.toThrow(/exactly one/);
    expect(submitMock).not.toHaveBeenCalled();
  });
});

describe('FalProvider — blocking Explainer media calls', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns plain provider URLs from the live-verified output fields', async () => {
    subscribeMock
      .mockResolvedValueOnce({ data: { video: { url: 'https://fal.media/scene.mp4' } }, requestId: 'omni-1' })
      .mockResolvedValueOnce({ data: { audio: { url: 'https://fal.media/voice.wav' } }, requestId: 'tts-1' })
      .mockResolvedValueOnce({ data: { audio: { url: 'https://fal.media/music.wav' } }, requestId: 'lyria-1' });

    await expect(falRunOmniI2v('custom/omni', {
      prompt: 'subtle motion',
      image_url: 'https://r2.example.com/still.png',
      aspect_ratio: '9:16',
      duration: 4,
    })).resolves.toBe('https://fal.media/scene.mp4');
    await expect(falRunTts('custom/tts', {
      prompt: 'Narration',
      voice: 'Kore',
      output_format: 'wav',
    })).resolves.toBe('https://fal.media/voice.wav');
    await expect(falRunLyria('custom/lyria', {
      prompt: 'ambient instrumental',
      negative_prompt: 'vocals',
    })).resolves.toBe('https://fal.media/music.wav');

    expect(subscribeMock).toHaveBeenNthCalledWith(1, 'custom/omni', {
      input: {
        prompt: 'subtle motion',
        image_url: 'https://r2.example.com/still.png',
        aspect_ratio: '9:16',
        duration: 4,
      },
    });
  });

  it('maps photo background removal to the live Pixelcut contract', async () => {
    subscribeMock.mockResolvedValue({
      data: { image: { url: 'https://fal.media/cutout.png' } },
      requestId: 'remove-bg-1',
    });

    await expect(
      falRunImageBackgroundRemoval('https://r2.example.com/source.jpg'),
    ).resolves.toBe('https://fal.media/cutout.png');

    expect(subscribeMock).toHaveBeenCalledWith(FAL_IMAGE_BACKGROUND_REMOVAL_MODEL, {
      input: {
        image_url: 'https://r2.example.com/source.jpg',
        output_format: 'rgba',
        sync_mode: false,
      },
    });
  });

  it('throws a credential-safe label and status for provider failures', async () => {
    const providerError = Object.assign(new Error('FAL_KEY=super-secret request body'), { status: 401 });
    subscribeMock.mockRejectedValue(providerError);

    let thrown: unknown;
    try {
      await falRunTts('custom/tts', { prompt: 'Narration', voice: 'Kore', output_format: 'wav' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Fal Gemini TTS failed (401)');
    expect((thrown as Error).message).not.toContain('super-secret');
  });

  it('throws a short status-bearing error when a completed call has no output URL', async () => {
    subscribeMock.mockResolvedValue({ data: {}, requestId: 'req-without-output' });

    await expect(falRunLyria('custom/lyria', {
      prompt: 'ambient instrumental',
      negative_prompt: 'vocals',
    })).rejects.toThrow('Fal Lyria2 returned no output (completed)');
  });
});
