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
    // 09.3-06: the REAL first-registry-drop shapes (actual preset_id, character_asset URL,
    // dialogue template, and style_grid ids/driving URLs mirrored from src/config/presets.ts) —
    // closes the gap between the synthetic 'test-gorilla-vlogs'/'test-viral-motions' fixtures
    // above and the live rows that actually shipped in 09.3-06.
    {
      preset_id: 'gorilla-vlogs',
      title: 'Gorilla Vlogs',
      section: 'shows_vlogs',
      sort_order: 1,
      status: 'live',
      media_type: 'video',
      model: 'bytedance/seedance-2.0-mini',
      i2v_routing: 'seedance',
      character_asset: 'https://assets.fantasia.example/presets/gorilla-vlogs/character-v1.jpg',
      script_expansion: true,
      dialogue_prompt_template:
        'Selfie-cam vlog style, handheld phone camera framing: a gorilla vlogger holds up the ' +
        'phone to film themself talking directly to the camera, natural gestures, casual vlog ' +
        'energy, speaking the following as spoken dialogue: {script}',
      input_schema: { slots: [], text: { label: 'Your script', required: true } },
      cost: { type: 'per_second', credits_per_sec: 9, max_seconds: 5 },
      tile: { poster_url: 'https://x.example/poster.jpg', loop_url: 'https://x.example/loop.mp4' },
    },
    {
      preset_id: 'viral-motions',
      title: 'Viral Motions',
      section: 'video_effects',
      sort_order: 5,
      status: 'live',
      media_type: 'avatar',
      model: 'bytedance/dreamactor-m2.0',
      input_schema: {
        slots: [{ kind: 'image', label: 'Your photo', source: 'any' }],
        style_grid: [
          {
            id: 'dance',
            label: 'Dance',
            driving_video_url: 'https://assets.fantasia.example/presets/viral-motions/dance-v1.mp4',
          },
          {
            id: 'runway',
            label: 'Runway',
            driving_video_url: 'https://assets.fantasia.example/presets/viral-motions/runway-v1.mp4',
          },
          {
            id: 'fight',
            label: 'Fight',
            driving_video_url: 'https://assets.fantasia.example/presets/viral-motions/fight-v1.mp4',
          },
        ],
      },
      cost: { type: 'per_second', credits_per_sec: 5, max_seconds: 30 },
      tile: { poster_url: 'https://x.example/poster.jpg', loop_url: 'https://x.example/loop.mp4' },
    },
    // 09.6-04: the chained-job primitive (D-01/D-05) — sole consumer is You vs You (UVU).
    {
      preset_id: 'test-you-vs-you',
      title: 'Test You vs You',
      section: 'video_effects',
      sort_order: 6,
      status: 'live',
      media_type: 'chain',
      model: 'alibaba/happyhorse-1.1', // animate model, for row display (set by def author)
      chain: {
        image_stage: {
          model: 'wan-video/wan-2.7-image',
          quality: 'high',
          prompts: ['opening keyframe: current-you walking into the dark arena', 'ending keyframe: young-you under the spotlight'],
        },
        animate_stage: {
          model: 'alibaba/happyhorse-1.1',
          resolution: '720p',
          duration: 8,
          aspect_ratio: '9:16',
          prompt_template: 'image-1 is the opening, image-2 is the ending reveal',
        },
      },
      input_schema: { slots: [{ kind: 'image', label: 'Your photo', source: 'any' }] },
      cost: { type: 'flat', credits: 1 },
      tile: { poster_url: 'https://x.example/poster.jpg', loop_url: 'https://x.example/loop.mp4' },
    },
  ];
  return { SERVER_PRESETS: FIXTURE_PRESETS };
});

jest.mock('../../db/client', () => ({ db: { select: jest.fn() } }));
jest.mock('../../db/schema', () => ({ referenceUploads: { id: 'id', user_id: 'user_id' } }));
jest.mock('../../services/archivalService', () => ({ getUploadPresignedUrl: jest.fn() }));

// config.ts calls requireEnv() at module-eval time — mock before openaiScriptService (transitively
// imported by presetResolver.ts) pulls it in.
jest.mock('../../config', () => ({ config: { openaiApiKey: 'mock-openai-key' } }));

// Deterministic, network-free stand-in for the real fail-open contract (openaiScriptService.test.ts
// covers the real fetch/fail-open behavior) — keeps this suite fast and offline.
jest.mock('../../services/openaiScriptService', () => ({
  expandScript: jest.fn(({ userScript, dialogueTemplate }: { userScript: string; dialogueTemplate: string }) =>
    Promise.resolve(dialogueTemplate.replace('{script}', userScript)),
  ),
}));

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

describe('presetResolver — 09.3-06 live registry shapes (SC3/SC4)', () => {
  it("real 'gorilla-vlogs' row injects character_asset and expands the script into dialogue", async () => {
    const req = makeReq({
      preset_id: 'gorilla-vlogs',
      text: 'my day at the office',
      preset_input_upload_ids: [],
    });
    const res = makeRes();
    const next = jest.fn();

    await presetResolver(req, res, next);

    expect(req.body.reference_images).toEqual(
      expect.arrayContaining(['https://assets.fantasia.example/presets/gorilla-vlogs/character-v1.jpg']),
    );
    expect(req.body.prompt).toContain('my day at the office');
    expect(req.body.model).toBe('bytedance/seedance-2.0-mini'); // i2v_routing:'seedance' — no Grok override
    expect(next).toHaveBeenCalled();
  });

  it("real 'viral-motions' row pairs the user selfie with the style-bundled driving video (not a second upload slot)", async () => {
    mockUploadRows([{ id: 'upload-selfie', r2_key: 'uploads/user-1/selfie.jpg' }]);
    const req = makeReq({
      preset_id: 'viral-motions',
      style_id: 'dance',
      preset_input_upload_ids: ['upload-selfie'],
    });
    const res = makeRes();
    const next = jest.fn();

    await presetResolver(req, res, next);

    expect(req.body.avatar_image).toBe('https://r2.example.com/signed/uploads/user-1/selfie.jpg');
    expect(req.body.avatar_driving_video).toBe(
      'https://assets.fantasia.example/presets/viral-motions/dance-v1.mp4',
    );
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

describe("presetResolver — 'chain' media_type (09.6-04, D-01/D-05)", () => {
  it('resolves the user photo slot into chain_input_images and stamps __chain_def, without overwriting prompt', async () => {
    mockUploadRows([{ id: 'upload-photo', r2_key: 'uploads/user-1/uvu-photo.jpg' }]);
    const req = makeReq({
      preset_id: 'test-you-vs-you',
      preset_input_upload_ids: ['upload-photo'],
    });
    const res = makeRes();
    const next = jest.fn();

    await presetResolver(req, res, next);

    expect(req.body.chain_input_images).toEqual(['https://r2.example.com/signed/uploads/user-1/uvu-photo.jpg']);
    expect(req.body.__chain_def).toEqual({
      image_stage: {
        model: 'wan-video/wan-2.7-image',
        quality: 'high',
        prompts: ['opening keyframe: current-you walking into the dark arena', 'ending keyframe: young-you under the spotlight'],
      },
      animate_stage: {
        model: 'alibaba/happyhorse-1.1',
        resolution: '720p',
        duration: 8,
        aspect_ratio: '9:16',
        prompt_template: 'image-1 is the opening, image-2 is the ending reveal',
      },
    });
    expect(req.body.media_type).toBe('chain');
    expect(req.body.prompt).toBe(''); // no prompt_template on chain presets — never overwritten with user text
    expect(next).toHaveBeenCalled();
  });

  it('rejects with 400 INVALID_PRESET_INPUT when no photo slot resolves', async () => {
    const req = makeReq({
      preset_id: 'test-you-vs-you',
      preset_input_upload_ids: [],
    });
    const res = makeRes();
    const next = jest.fn();

    await presetResolver(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_PRESET_INPUT' }));
    expect(next).not.toHaveBeenCalled();
  });
});
