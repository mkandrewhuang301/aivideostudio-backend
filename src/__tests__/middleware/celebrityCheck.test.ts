// Mock config first — config.ts calls requireEnv() at module eval time. Mutable so each test can
// toggle celebrityCheckEnabled.
const mockConfig = { celebrityCheckEnabled: false };
jest.mock('../../config', () => ({ config: mockConfig }));

// Mock the service so no AWS/network call happens.
const mockCheckCelebrity = jest.fn();
jest.mock('../../services/celebrityService', () => ({
  checkCelebrity: (...args: unknown[]) => mockCheckCelebrity(...args),
}));

import { Request, Response, NextFunction } from 'express';
import { celebrityCheckMiddleware } from '../../middleware/celebrityCheck';

function makeReqResNext(resolved: Record<string, unknown> | undefined) {
  const req = { _resolved: resolved } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('celebrityCheckMiddleware', () => {
  beforeEach(() => {
    mockCheckCelebrity.mockReset();
    mockConfig.celebrityCheckEnabled = true;
  });

  it('no-ops (calls next, no check) when the feature is disabled', async () => {
    mockConfig.celebrityCheckEnabled = false;
    const { req, res, next } = makeReqResNext({ mediaType: 'avatar', avatarImage: 'https://r2/face.jpg' });

    await celebrityCheckMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockCheckCelebrity).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('skips non-face presets (e.g. plain video) without calling the check', async () => {
    const { req, res, next } = makeReqResNext({ mediaType: 'video' });

    await celebrityCheckMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockCheckCelebrity).not.toHaveBeenCalled();
  });

  it('checks the avatarImage for motion-transfer and blocks a celebrity match with 400', async () => {
    mockCheckCelebrity.mockResolvedValue({ matched: true, name: 'Famous Person', confidence: 98 });
    const { req, res, next } = makeReqResNext({ mediaType: 'avatar', avatarImage: 'https://r2/face.jpg' });

    await celebrityCheckMiddleware(req, res, next);

    expect(mockCheckCelebrity).toHaveBeenCalledWith('https://r2/face.jpg');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'celebrity_likeness_blocked' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('checks the characterReplaceImage for ai-influencer and blocks a match', async () => {
    mockCheckCelebrity.mockResolvedValue({ matched: true, name: 'Famous Person', confidence: 95 });
    const { req, res, next } = makeReqResNext({ mediaType: 'character_replace', characterReplaceImage: 'https://r2/char.jpg' });

    await celebrityCheckMiddleware(req, res, next);

    expect(mockCheckCelebrity).toHaveBeenCalledWith('https://r2/char.jpg');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes a non-celebrity face through to next()', async () => {
    mockCheckCelebrity.mockResolvedValue({ matched: false });
    const { req, res, next } = makeReqResNext({ mediaType: 'avatar', avatarImage: 'https://r2/face.jpg' });

    await celebrityCheckMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('skips when the face slot is missing', async () => {
    const { req, res, next } = makeReqResNext({ mediaType: 'avatar' });

    await celebrityCheckMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockCheckCelebrity).not.toHaveBeenCalled();
  });
});
