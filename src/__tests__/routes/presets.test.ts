// src/__tests__/routes/presets.test.ts
// Wave 0 gap test — covers SC1 (registry shape, no-app-release config-driven serialization),
// D-11/T-09.1-01 (prompt_template never leaks to the client), SC6 (every live row has art URLs).

import express from 'express';
import request from 'supertest';
import { SERVER_PRESETS, CLIENT_PRESETS, PRESETS_VERSION } from '../../config/presets';
import { presetsRouter } from '../../routes/presets';

const app = express();
app.use('/api/presets', presetsRouter);

describe('presets registry config', () => {
  it('exports a numeric PRESETS_VERSION', () => {
    expect(typeof PRESETS_VERSION).toBe('number');
  });

  it('includes all 22 live presets (7 original + AI Influencer D-23 + Clothes Swap 09.1-11 + Faceswap 09.2-07 + Magic Editor 09.2-08 + 09.3-06 8-row registry drop + 09.6-08 kbo-fan-cam/marlon-motion + 09.6-06 you-vs-you)', () => {
    const liveIds = SERVER_PRESETS.filter((p) => p.status === 'live').map((p) => p.preset_id);
    expect(liveIds.sort()).toEqual(
      [
        'motion-transfer',
        'enhancer-video',
        'enhancer-image',
        'hairstyle',
        'anime-yourself',
        'polaroid',
        'animate-old-photo',
        'ai-influencer',
        'clothes-swap',
        'faceswap',
        'magic-editor',
        'gorilla-vlogs',
        'viral-motions',
        'camera-moves',
        'vfx-pack',
        'action-figure',
        'yearbook-90s',
        'pro-headshot',
        'restore-old-photo',
        'kbo-fan-cam',
        'marlon-motion',
        'you-vs-you',
      ].sort(),
    );
  });

  it('includes the SOON rows (registry-driven, not hardcoded UI — D-04)', () => {
    // 'try-on' was activated as the live 'clothes-swap' preset (09.1-11, supersedes the earlier
    // avatar-based AI Try-On concept — see 09.1-CONTEXT.md D-24 SUPERSEDED banner) and is no
    // longer SOON. 'faceswap' was activated as a live preset (09.2-07) and is also no longer SOON.
    // 09.3 SC3/SC5: 'gorilla-vlogs' flipped soon→live as the character-system proof (D-05, shipped
    // 09.3-06) — this is the permanent regression guard for that flip.
    const soonIds = SERVER_PRESETS.filter((p) => p.status === 'soon').map((p) => p.preset_id);
    expect(soonIds).toEqual(
      expect.arrayContaining(['edit-studio', 'avatar-center', 'fruit-island']),
    );
    expect(soonIds).not.toContain('try-on');
    expect(soonIds).not.toContain('faceswap');
    expect(soonIds).not.toContain('gorilla-vlogs');
  });

  it('CLIENT_PRESETS strips prompt_template from every row', () => {
    for (const preset of CLIENT_PRESETS) {
      expect(preset).not.toHaveProperty('prompt_template');
    }
    expect(JSON.stringify(CLIENT_PRESETS)).not.toContain('prompt_template');
  });

  it('keeps bundled preset reference assets server-only', () => {
    const serverPolaroid = SERVER_PRESETS.find((p) => p.preset_id === 'polaroid');
    const clientPolaroid = CLIENT_PRESETS.find((p) => p.preset_id === 'polaroid');
    expect(serverPolaroid?.fixed_reference_keys).toHaveLength(2);
    expect(serverPolaroid?.tile.poster_url).toContain('/presets/polaroid/poster-v1.jpg');
    expect(serverPolaroid?.tile.loop_url).toContain('/presets/polaroid/loop-v1.mp4');
    expect(clientPolaroid).not.toHaveProperty('fixed_reference_keys');
    expect(JSON.stringify(CLIENT_PRESETS)).not.toContain('preset-assets/polaroid/references/');
  });

  // 09.3 (SC3): the character-system registry fields (D-03/D-05) are server-only — this is now a
  // live regression guard since the 09.3-06 8-row drop actually exercises these fields
  // (gorilla-vlogs's character_asset/script_expansion/dialogue_prompt_template, viral-motions'
  // style_grid driving_video_url).
  it('CLIENT_PRESETS strips the new 09.3 character-system server-only fields from every row (SC3)', () => {
    for (const preset of CLIENT_PRESETS) {
      expect(preset).not.toHaveProperty('character_asset');
      expect(preset).not.toHaveProperty('dialogue_prompt_template');
      expect(preset).not.toHaveProperty('script_expansion');
      expect(preset).not.toHaveProperty('postprocess');
      expect(preset).not.toHaveProperty('i2v_routing');
    }
    const serialized = JSON.stringify(CLIENT_PRESETS);
    expect(serialized).not.toContain('character_asset');
    expect(serialized).not.toContain('dialogue_prompt_template');
    expect(serialized).not.toContain('script_expansion');
    expect(serialized).not.toContain('driving_video_url');
    expect(serialized).not.toContain('postprocess');
  });

  // 09.6-08 (SC3/D-11, T-09.6-21): kbo-fan-cam/marlon-motion's server-only fields — the strong
  // stadium prompt and Marlon's bundled driver clip key must never leak to the client.
  it('CLIENT_PRESETS strips driver_video_asset and postprocess from every row (SC3/D-11, T-09.6-21)', () => {
    for (const preset of CLIENT_PRESETS) {
      expect(preset).not.toHaveProperty('driver_video_asset');
      expect(preset).not.toHaveProperty('postprocess');
    }
    const serialized = JSON.stringify(CLIENT_PRESETS);
    expect(serialized).not.toContain('driver_video_asset');
    expect(serialized).not.toContain('assets/presets/marlon-motion/driver-v1.mp4');
  });

  // 09.6-06 (SC3/D-11, T-09.6-17): you-vs-you's `chain` descriptor (both keyframe prompts + the
  // HappyHorse choreography prompt_template) is server-only IP and must never reach the client.
  it('CLIENT_PRESETS strips chain from every row (T-09.6-17)', () => {
    for (const preset of CLIENT_PRESETS) {
      expect(preset).not.toHaveProperty('chain');
    }
    // Note: media_type:'chain' is a legitimate client-safe VALUE (the you-vs-you row's media
    // type) — only the def.chain OBJECT (key) is server-only, so this asserts on its unique
    // nested content rather than the substring "chain" (which also matches the media_type value).
    const serialized = JSON.stringify(CLIENT_PRESETS);
    expect(serialized).not.toContain('wan-video/wan-2.7-image');
    expect(serialized).not.toContain('young-you under the spotlight');
    expect(serialized).not.toContain('image-1 as the opening shot');
  });

  // 09.3-06: PresetSheetMeta.preparing_label is deliberately CLIENT-SAFE (unlike every other
  // server-only field stripped above) — gorilla-vlogs's client projection must still carry the
  // "Writing your script…" caption for the iOS PresetInputSheet submitting state.
  it('CLIENT_PRESETS preserves sheet.preparing_label on the gorilla-vlogs client projection', () => {
    const gorilla = CLIENT_PRESETS.find((p) => p.preset_id === 'gorilla-vlogs');
    expect(gorilla?.sheet?.preparing_label).toBe('Writing your script…');
  });

  // 09.3-06: the first registry drop — gorilla vlogger (character system proof), viral motion
  // pack (DreamActor bundled driving video), camera-move + VFX packs, and 4 image templates
  // (Action Figure / 90s Yearbook / Pro Headshot / Restore Old Photo per CONTEXT D-06 Claude's-
  // discretion suggestion) — now live as a permanent regression guard.
  it('includes the 09.3 first registry drop as live rows (SC3/SC4/SC5)', () => {
    const liveIds = SERVER_PRESETS.filter((p) => p.status === 'live').map((p) => p.preset_id);
    expect(liveIds).toEqual(
      expect.arrayContaining([
        'gorilla-vlogs',
        'viral-motions',
        'camera-moves',
        'vfx-pack',
        'action-figure',
        'yearbook-90s',
        'pro-headshot',
        'restore-old-photo',
      ]),
    );
  });

  it('CLIENT_PRESETS has the same length as SERVER_PRESETS (config-driven — SC1)', () => {
    expect(CLIENT_PRESETS.length).toBe(SERVER_PRESETS.length);
  });

  it('every live row has both tile.poster_url and tile.loop_url (SC6)', () => {
    for (const preset of SERVER_PRESETS.filter((p) => p.status === 'live')) {
      expect(preset.tile.poster_url).toBeTruthy();
      expect(preset.tile.loop_url).toBeTruthy();
    }
  });

  // Preset Sheet Redesign: every live row needs a `sheet.description` for the new header, and
  // each row declares EITHER selectable aspect_ratios (+ a default that is itself one of the
  // options) OR a fixed aspect_label — never neither, never both.
  it('every live row has sheet.description and exactly one aspect strategy (chips xor fixed label)', () => {
    for (const preset of SERVER_PRESETS.filter((p) => p.status === 'live')) {
      expect(preset.sheet?.description).toBeTruthy();
      const hasChips = Boolean(preset.sheet?.aspect_ratios?.length);
      const hasFixedLabel = Boolean(preset.sheet?.aspect_label);
      expect(hasChips !== hasFixedLabel).toBe(true);
      if (hasChips) {
        expect(preset.sheet?.default_aspect_ratio).toBeTruthy();
        expect(preset.sheet?.aspect_ratios).toContain(preset.sheet?.default_aspect_ratio);
      }
    }
  });

  it('GPT-Image-2 presets only offer aspect ratios the live gpt-image-2 schema accepts', () => {
    const gptPresets = SERVER_PRESETS.filter((p) => p.model === 'openai/gpt-image-2-medium');
    expect(gptPresets.length).toBeGreaterThan(0);
    for (const preset of gptPresets) {
      for (const ratio of preset.sheet?.aspect_ratios ?? []) {
        expect(['1:1', '3:2', '2:3', '16:9', '9:16', 'auto']).toContain(ratio);
      }
    }
  });
});

describe('GET /api/presets', () => {
  it('returns 200 with a numeric version and a non-empty presets array (SC1)', async () => {
    const res = await request(app).get('/api/presets');
    expect(res.status).toBe(200);
    expect(typeof res.body.version).toBe('number');
    expect(Array.isArray(res.body.presets)).toBe(true);
    expect(res.body.presets.length).toBeGreaterThan(0);
  });

  it('never includes prompt_template in the response body (D-11)', async () => {
    const res = await request(app).get('/api/presets');
    expect(JSON.stringify(res.body)).not.toContain('prompt_template');
  });

  it('is config-driven: response preset count equals CLIENT_PRESETS.length (SC1 no-app-release)', async () => {
    const res = await request(app).get('/api/presets');
    expect(res.body.presets.length).toBe(CLIENT_PRESETS.length);
  });

  it('every live preset in the response has tile.poster_url and tile.loop_url (SC6 URL lint)', async () => {
    const res = await request(app).get('/api/presets');
    const live = res.body.presets.filter((p: { status: string }) => p.status === 'live');
    expect(live.length).toBeGreaterThan(0);
    for (const preset of live) {
      expect(preset.tile.poster_url).toBeTruthy();
      expect(preset.tile.loop_url).toBeTruthy();
    }
  });
});
