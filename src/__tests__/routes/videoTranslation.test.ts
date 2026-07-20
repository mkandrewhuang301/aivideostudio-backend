const getGenerationMock = jest.fn();
const createGenerationMock = jest.fn();
const attachPredictionIdMock = jest.fn();
const markFailedMock = jest.fn();
const deductMock = jest.fn();
const refundMock = jest.fn();
const presignMock = jest.fn();
const probeMock = jest.fn();
const dispatchMock = jest.fn();

jest.mock('../../services/generationService', () => ({
  getGenerationById: getGenerationMock,
  createGeneration: createGenerationMock,
  attachPredictionId: attachPredictionIdMock,
  markFailed: markFailedMock,
}));
jest.mock('../../services/creditService', () => ({
  deductCredits: deductMock,
  refundCredits: refundMock,
}));
jest.mock('../../services/archivalService', () => ({
  getGenerationPresignedUrl: presignMock,
}));
jest.mock('../../services/mediaProbe', () => ({
  probeDurationSeconds: probeMock,
}));
jest.mock('../../services/providers/FalProvider', () => ({
  FalProvider: class { dispatch = dispatchMock; },
}));
jest.mock('../../config', () => ({
  getFalWebhookUrl: () => 'https://api.example.com/webhooks/fal',
}));

import express from 'express';
import request from 'supertest';
import { videoTranslationRouter } from '../../routes/videoTranslation';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { uid: 'firebase-1', dbUserId: 'user-1' };
  next();
});
app.use('/api/generations', videoTranslationRouter);

const source = {
  id: 'source-1',
  user_id: 'user-1',
  status: 'completed',
  media_type: 'video',
  r2_key: 'generations/source-1.mp4',
  has_real_face_input: true,
  params: { resolution: '720p', aspect_ratio: '9:16' },
};

beforeEach(() => {
  jest.clearAllMocks();
  getGenerationMock.mockResolvedValue(source);
  presignMock.mockResolvedValue('https://r2.example.com/source.mp4');
  probeMock.mockResolvedValue(12.2);
  deductMock.mockResolvedValue(true);
  createGenerationMock.mockResolvedValue({ id: 'translation-1' });
  dispatchMock.mockResolvedValue({ providerPredictionId: 'fal-ai/heygen/v2/translate/speed::req-1' });
  attachPredictionIdMock.mockResolvedValue(undefined);
  markFailedMock.mockResolvedValue(true);
  refundMock.mockResolvedValue(undefined);
});

describe('POST /api/generations/:id/translate', () => {
  it('probes before billing, creates a derived row, and dispatches the owned R2 URL', async () => {
    const res = await request(app)
      .post('/api/generations/source-1/translate')
      .send({ output_language: 'Spanish' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generation_id: 'translation-1', status: 'processing', cost_credits: 65 });
    expect(probeMock).toHaveBeenCalledWith('https://r2.example.com/source.mp4');
    expect(deductMock).toHaveBeenCalledWith('user-1', 65);
    expect(createGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'fal-ai/heygen/v2/translate/speed',
      cost_credits: 65,
      has_real_face_input: true,
      params: expect.objectContaining({ output_language: 'Spanish', source_generation_id: 'source-1' }),
    }));
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      referenceVideos: ['https://r2.example.com/source.mp4'],
      videoTranslationLanguage: 'Spanish',
    }), 'https://api.example.com/webhooks/fal');
  });

  it('rejects over-eight-minute clips before deducting credits', async () => {
    probeMock.mockResolvedValue(480.01);
    const res = await request(app)
      .post('/api/generations/source-1/translate')
      .send({ output_language: 'French' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VIDEO_TOO_LONG');
    expect(deductMock).not.toHaveBeenCalled();
  });

  it('rejects non-enum languages before looking up the source', async () => {
    const res = await request(app)
      .post('/api/generations/source-1/translate')
      .send({ output_language: 'Vietnamese' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LANGUAGE');
    expect(getGenerationMock).not.toHaveBeenCalled();
  });

  it('fully refunds when provider dispatch fails', async () => {
    dispatchMock.mockRejectedValue(new Error('fal unavailable'));
    const res = await request(app)
      .post('/api/generations/source-1/translate')
      .send({ output_language: 'Dutch' });

    expect(res.status).toBe(502);
    expect(markFailedMock).toHaveBeenCalledWith('translation-1', 'provider_error');
    expect(refundMock).toHaveBeenCalledWith(
      'user-1', 65, 'translation-dispatch-failure-translation-1',
    );
  });
});
