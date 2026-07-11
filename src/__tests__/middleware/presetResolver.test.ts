// src/__tests__/middleware/presetResolver.test.ts
// Wave 0 scaffold (09.3-01) — SC3 character_asset/script_expansion injection, SC4 motion-pack
// bundled driving-video pairing (DreamActor), and the D-02 i2v_routing pre-route (Grok vs
// Seedance). RED until 09.3-05/06 extends presetResolver.ts's switch cases with these fields —
// today's resolver only knows media_type 'avatar' | 'character_replace' | 'upscale' | 'image' |
// 'faceswap' | 'video' and has NO character_asset / script_expansion / i2v_routing handling.
//
// This suite mocks the registry (SERVER_PRESETS) with fixture defs carrying the NEW 09.3 fields
// so it doesn't depend on which real preset rows exist yet — 09.3-05/06/07 land those separately
// (see the extended src/__tests__/routes/presets.test.ts for the real-row coverage).

jest.mock('../../config/presets', () => {
  const FIXTURE_PRESETS = [
    {
      preset_id: 'test-gorilla-vlogs',
      title: 'Test Gorilla Vlogs',
      section: 'shows_vlogs',
      sort_order: 1,
      status: 'live',
      media_type: 'video',
      model: 'bytedance/seedance-2.0-mini',
      // NEW 09.3 fields (D-03/D-05) — not yet read by presetResolver.ts.
      character_asset: 'https://r2.example.com/assets/gorilla-vlogs/character.png',
      script_expansion: true,
      dialogue_prompt_template: 'A gorilla vlogger holding a phone says: {script}',
      input_schema: { slots: [], text: { label: 'Your script', required: true } },
      cost: { type: 'per_second', credits_per_sec: 8, max_seconds: 8 },
      tile: { poster_url: 'https://x.example/poster.jpg', loop_url: 'https://x.example/loop.mp4' },
    },
    {
      preset_id: 'test-viral-motions',
      title: 'Test Viral Motions',
      section: 'video_effects',
      sort_order: 1,
      status: 'live',
      media_type: 'avatar',
      model: 'bytedance/dreamactor-m2.0',
      input_schema: {
        slots: [{ kind: 'image', label: 'Your selfie', source: 'any' }],
        // NEW 09.3 field — the driving video is a bundled server asset per style option (D-04),
        // NOT a second user-uploaded slot like Motion Transfer's avatar_driving_video.
        style_grid: [
          {
            id: 'dance-1',
            label: 'Viral Dance 1',
            driving_video_url: 'https://r2.example.com/assets/viral-motions/dance-1.mp4',
          },
        ],
      },
      cost: { type: 'per_second', credits_per_sec: 8, max_seconds: 6 },
      tile: { poster_url: 'https://x.example/poster.jpg', loop_url: 'https://x.example/loop.mp4' },
    },
    {
      preset_id: 'test-real-face-i2v',
      title: 'Test Real Face i2v',
      section: 'video_effects',
      sort_order: 2,
      status: 'live',
      media_type: 'video',
      model: 'bytedance/seedance-2.0-mini',
      // D-02 pre-route: known real-face preset → Grok directly (skip the doomed Seedance attempt).
      i2v_routing: 'grok',
      input_schema: { slots: [{ kind: 'image', label: 'Your photo', source: 'any' }] },
      cost: { type: 'per_second', credits_per_sec: 8, max_seconds: 5 },
      tile: { poster_url: 'https://x.example/poster.jpg', loop_url: 'https://x.example/loop.mp4' },
    },
    {
      preset_id: 'test-fictional-i2v',
      title: 'Test Fictional i2v',
      section: 'video_effects',
      sort_order: 3,
      status: 'live',
      media_type: 'video',
      model: 'bytedance/seedance-2.0-mini',
      // D-02 pre-route: known-fictional preset → Seedance directly (best quality, accepts it).
      i2v_routing: 'seedance',
      input_schema: { slots: [{ kind: 'image', label: 'Your photo', source: 'any' }] },
      cost: { type: 'per_second', credits_per_sec: 8, max_seconds: 5 },
      tile: { poster_url: 'https://x.example/poster.jpg', loop_url: 'https://x.example/loop.mp4' },
    },
  ];
  return { SERVER_PRESETS: FIXTURE_PRESETS };
});

jest.mock('../../db/client', () => ({ db: { select: jest.fn() } }));
jest.mock('../../db/schema', () => ({ referenceUploads: { id: 'id', user_id: 'user_id' } }));
jest.mock('../../services/archivalService', () => ({ getUploadPresignedUrl: jest.fn() }));

import { Request, Response } from 'express';
import { db } from '../../db/client';
import { getUploadPresignedUrl } from '../../services/archivalService';
import { presetResolver } from '../../middleware/presetResolver';

function makeReq(body: Record<string, unknown>, user?: { dbUserId: string }): Request {
  return { body, user: user ?? { dbUserId: 'user-1' } } as unknown as Request;
}

function makeRes(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function mockUploadRows(rows: Array<{ id: string; r2_key: string }>): void {
  (db.select as jest.Mock).mockReturnValue({
    from: jest.fn(() => ({
      where: jest.fn().mockResolvedValue(rows.map((r) => ({ ...r, user_id: 'user-1' }))),
    })),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (getUploadPresignedUrl as jest.Mock).mockImplementation((key: string) =>
    Promise.resolve(`https://r2.example.com/signed/${key}`),
  );
});

describe('presetResolver — character system (SC3, RED until 09.3-05/06)', () => {
  it('injects the character_asset into reference_images and expands the user script into the prompt', async () => {
    const req = makeReq({
      preset_id: 'test-gorilla-vlogs',
      text: 'my day at the office',
      preset_input_upload_ids: [],
    });
    const res = makeRes();
    const next = jest.fn();

    await presetResolver(req, res, next);

    expect(req.body.reference_images).toEqual(
      expect.arrayContaining(['https://r2.example.com/assets/gorilla-vlogs/character.png']),
    );
    expect(req.body.prompt).toContain('my day at the office');
    expect(next).toHaveBeenCalled();
  });
});

describe('presetResolver — motion pack bundled driving video (SC4, RED until 09.3-05/06)', () => {
  it('pairs the user selfie slot with the STYLE-BUNDLED driving video, not a second user upload slot', async () => {
    mockUploadRows([{ id: 'upload-selfie', r2_key: 'uploads/user-1/selfie.jpg' }]);
    const req = makeReq({
      preset_id: 'test-viral-motions',
      style_id: 'dance-1',
      preset_input_upload_ids: ['upload-selfie'],
    });
    const res = makeRes();
    const next = jest.fn();

    await presetResolver(req, res, next);

    expect(req.body.avatar_image).toBe('https://r2.example.com/signed/uploads/user-1/selfie.jpg');
    expect(req.body.avatar_driving_video).toBe('https://r2.example.com/assets/viral-motions/dance-1.mp4');
    expect(next).toHaveBeenCalled();
  });
});

describe('presetResolver — D-02 i2v_routing pre-route (SC2, RED until 09.3-03)', () => {
  it("i2v_routing:'grok' overwrites req.body.model to the permissive real-face model", async () => {
    mockUploadRows([{ id: 'upload-photo', r2_key: 'uploads/user-1/photo.jpg' }]);
    const req = makeReq({
      preset_id: 'test-real-face-i2v',
      preset_input_upload_ids: ['upload-photo'],
    });
    const res = makeRes();
    const next = jest.fn();

    await presetResolver(req, res, next);

    expect(req.body.model).toBe('xai/grok-imagine-video-1.5');
    expect(next).toHaveBeenCalled();
  });

  it("i2v_routing:'seedance' leaves req.body.model as the preset's declared Seedance id (not RED — verifies no regression)", async () => {
    mockUploadRows([{ id: 'upload-photo', r2_key: 'uploads/user-1/photo2.jpg' }]);
    const req = makeReq({
      preset_id: 'test-fictional-i2v',
      preset_input_upload_ids: ['upload-photo'],
    });
    const res = makeRes();
    const next = jest.fn();

    await presetResolver(req, res, next);

    expect(req.body.model).toBe('bytedance/seedance-2.0-mini');
    expect(next).toHaveBeenCalled();
  });
});
