// Mock config first — config.ts calls requireEnv() at module eval time. Mutable so each test can
// toggle hiveInputScanEnabled.
const mockConfig = { hiveInputScanEnabled: false };
jest.mock('../../config', () => ({ config: mockConfig }));

// Mock the scan service so no network call happens.
const mockScanInputMedia = jest.fn();
jest.mock('../../services/hiveService', () => ({
  scanInputMedia: (...args: unknown[]) => mockScanInputMedia(...args),
}));

import { Request, Response, NextFunction } from 'express';
import { inputMediaGate } from '../../middleware/inputMediaGate';

function makeReqResNext(
  resolved: Record<string, unknown> | undefined,
  preset?: { preset_id: string; input_upload_ids: Array<string | null> },
) {
  const req = { _resolved: resolved, _preset: preset } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('inputMediaGate', () => {
  beforeEach(() => {
    mockScanInputMedia.mockReset();
    mockConfig.hiveInputScanEnabled = true;
  });

  it('skips non-face-input requests (e.g. plain video) without calling scanInputMedia', async () => {
    const { req, res, next } = makeReqResNext({ mediaType: 'video' });

    await inputMediaGate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockScanInputMedia).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('no-ops (calls next, no scan) when HIVE_INPUT_SCAN_ENABLED is false', async () => {
    mockConfig.hiveInputScanEnabled = false;
    const { req, res, next } = makeReqResNext({ mediaType: 'avatar', avatarImage: 'https://r2/face.jpg' });

    await inputMediaGate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockScanInputMedia).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks a Motion Transfer avatar face with 403 when scanInputMedia flags nsfw', async () => {
    mockScanInputMedia.mockResolvedValue({ blocked: true, reason: 'nsfw' });
    const { req, res, next } = makeReqResNext({ mediaType: 'avatar', avatarImage: 'https://r2/face.jpg' });

    await inputMediaGate(req, res, next);

    expect(mockScanInputMedia).toHaveBeenCalledWith('https://r2/face.jpg');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INPUT_MEDIA_BLOCKED', reason: 'nsfw' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('passes a clean Motion Transfer avatar face through to next()', async () => {
    mockScanInputMedia.mockResolvedValue({ blocked: false });
    const { req, res, next } = makeReqResNext({ mediaType: 'avatar', avatarImage: 'https://r2/face.jpg' });

    await inputMediaGate(req, res, next);

    expect(mockScanInputMedia).toHaveBeenCalledWith('https://r2/face.jpg');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('fails safe (403, no next) when scanInputMedia throws', async () => {
    mockScanInputMedia.mockRejectedValue(new Error('Hive API error: 500'));
    const { req, res, next } = makeReqResNext({ mediaType: 'avatar', avatarImage: 'https://r2/face.jpg' });

    await inputMediaGate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INPUT_MEDIA_SCAN_ERROR' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('also gates via preset_id (faceswap) when media_type is not yet set to faceswap', async () => {
    mockScanInputMedia.mockResolvedValue({ blocked: false });
    const { req, res, next } = makeReqResNext(
      { mediaType: 'avatar', avatarImage: 'https://r2/face.jpg' },
      { preset_id: 'motion-transfer', input_upload_ids: ['abc'] },
    );

    await inputMediaGate(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  // 09.6 GAP-2: video/character_replace face-input coverage. UVU's 'chain' media_type case is
  // covered in the describe block below (09.6-04).
  describe('09.6 GAP-2: video/character_replace face-input coverage', () => {
    it('blocks KBO (registered "video" preset) selfie with 403 when scanInputMedia flags nsfw', async () => {
      mockScanInputMedia.mockResolvedValue({ blocked: true, reason: 'nsfw' });
      const { req, res, next } = makeReqResNext(
        { mediaType: 'video', referenceImages: ['https://r2/kbo-selfie.jpg'] },
        { preset_id: 'kbo-fan-cam', input_upload_ids: ['sel-1'] },
      );

      await inputMediaGate(req, res, next);

      expect(mockScanInputMedia).toHaveBeenCalledWith('https://r2/kbo-selfie.jpg');
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INPUT_MEDIA_BLOCKED', reason: 'nsfw' }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('passes a clean KBO (registered "video" preset) selfie through to next()', async () => {
      mockScanInputMedia.mockResolvedValue({ blocked: false });
      const { req, res, next } = makeReqResNext(
        { mediaType: 'video', referenceImages: ['https://r2/kbo-selfie.jpg'] },
        { preset_id: 'kbo-fan-cam', input_upload_ids: ['sel-1'] },
      );

      await inputMediaGate(req, res, next);

      expect(mockScanInputMedia).toHaveBeenCalledWith('https://r2/kbo-selfie.jpg');
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('does NOT scan an unregistered "video" preset (freeform camera-moves) — stays ungated', async () => {
      const { req, res, next } = makeReqResNext(
        { mediaType: 'video', referenceImages: ['https://r2/camera-moves-input.jpg'] },
        { preset_id: 'camera-moves', input_upload_ids: ['ref-1'] },
      );

      await inputMediaGate(req, res, next);

      expect(mockScanInputMedia).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('scans the face photo for a registered character_replace preset', async () => {
      mockScanInputMedia.mockResolvedValue({ blocked: false });
      const { req, res, next } = makeReqResNext(
        { mediaType: 'character_replace', characterReplaceImage: 'https://r2/marlon-face.jpg' },
        { preset_id: 'marlon-motion', input_upload_ids: ['face-1', 'vid-1'] },
      );

      await inputMediaGate(req, res, next);

      expect(mockScanInputMedia).toHaveBeenCalledWith('https://r2/marlon-face.jpg');
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  // 09.6-04: the chained-job primitive's 'chain' media_type — sole consumer is You vs You (UVU).
  describe("09.6-04: 'chain' media_type face-input coverage (You vs You)", () => {
    it('scans the resolved photo slot(s) for a registered chain preset (you-vs-you)', async () => {
      mockScanInputMedia.mockResolvedValue({ blocked: false });
      const { req, res, next } = makeReqResNext(
        { mediaType: 'chain', chainInputImages: ['https://r2/uvu-photo.jpg'] },
        { preset_id: 'you-vs-you', input_upload_ids: ['photo-1'] },
      );

      await inputMediaGate(req, res, next);

      expect(mockScanInputMedia).toHaveBeenCalledWith('https://r2/uvu-photo.jpg');
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('blocks a registered chain preset (you-vs-you) with 403 when scanInputMedia flags nsfw', async () => {
      mockScanInputMedia.mockResolvedValue({ blocked: true, reason: 'nsfw' });
      const { req, res, next } = makeReqResNext(
        { mediaType: 'chain', chainInputImages: ['https://r2/uvu-photo.jpg'] },
        { preset_id: 'you-vs-you', input_upload_ids: ['photo-1'] },
      );

      await inputMediaGate(req, res, next);

      expect(mockScanInputMedia).toHaveBeenCalledWith('https://r2/uvu-photo.jpg');
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INPUT_MEDIA_BLOCKED', reason: 'nsfw' }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });
});
