// Mock config first — config.ts calls requireEnv() at module eval time
jest.mock('../../config', () => ({
  config: {
    openaiApiKey: 'test-openai-key',
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { Request, Response, NextFunction } from 'express';
import { promptModerationMiddleware } from '../../middleware/promptModeration';

function makeReqResNext(body: Record<string, unknown>) {
  const req = { body } as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('promptModerationMiddleware', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('blocks a prompt matching the blocklist and returns 400', async () => {
    const { req, res, next } = makeReqResNext({ prompt: 'hot sexy nude woman' });
    // OpenAI should not even need to be called if blocklist fires, but mock it clean just in case
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ categories: { 'sexual/minors': false, 'violence/graphic': false } }] }),
    });

    await promptModerationMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'content_policy_violation' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('passes a clean prompt through and calls next()', async () => {
    const { req, res, next } = makeReqResNext({ prompt: 'a beautiful sunset over mountains' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ categories: { 'sexual/minors': false, 'violence/graphic': false } }] }),
    });

    await promptModerationMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks a prompt flagged by OpenAI Moderation (sexual/minors)', async () => {
    const { req, res, next } = makeReqResNext({ prompt: 'an innocent looking scene' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ categories: { 'sexual/minors': true, 'violence/graphic': false } }] }),
    });

    await promptModerationMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'content_policy_violation' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when prompt is missing or empty (validation deferred to prepareCost)', async () => {
    const { req, res, next } = makeReqResNext({});

    await promptModerationMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls next() when OpenAI API throws — fails open so blocklist still protects clean prompts', async () => {
    const { req, res, next } = makeReqResNext({ prompt: 'a beautiful forest' });
    mockFetch.mockRejectedValue(new Error('Network error'));

    await promptModerationMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when OpenAI returns non-ok status — fails open', async () => {
    const { req, res, next } = makeReqResNext({ prompt: 'a beautiful sunset' });
    mockFetch.mockResolvedValue({ ok: false, status: 429 });

    await promptModerationMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks prompts blocked by the regex even when OpenAI is down', async () => {
    const { req, res, next } = makeReqResNext({ prompt: 'nude woman' });
    mockFetch.mockRejectedValue(new Error('Network error'));

    await promptModerationMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when prompt exceeds 2000 characters', async () => {
    const { req, res, next } = makeReqResNext({ prompt: 'a'.repeat(2001) });

    await promptModerationMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'prompt_too_long' }));
    expect(next).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes a prompt at exactly 2000 characters', async () => {
    const { req, res, next } = makeReqResNext({ prompt: 'a'.repeat(2000) });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ categories: { 'sexual/minors': false, 'violence/graphic': false } }] }),
    });

    await promptModerationMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
