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

  it('includes all 7 wave-1 live presets', () => {
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
      ].sort(),
    );
  });

  it('includes the SOON rows (registry-driven, not hardcoded UI — D-04)', () => {
    const soonIds = SERVER_PRESETS.filter((p) => p.status === 'soon').map((p) => p.preset_id);
    expect(soonIds).toEqual(
      expect.arrayContaining(['cinema-studio', 'try-on', 'faceswap', 'avatar-center', 'gorilla-vlogs', 'fruit-island']),
    );
  });

  it('CLIENT_PRESETS strips prompt_template from every row', () => {
    for (const preset of CLIENT_PRESETS) {
      expect(preset).not.toHaveProperty('prompt_template');
    }
    expect(JSON.stringify(CLIENT_PRESETS)).not.toContain('prompt_template');
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
