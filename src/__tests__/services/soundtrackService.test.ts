jest.mock('../../config', () => ({
  config: {
    aiMusicMaxDurationSeconds: 184,
    aiMusicClipModel: 'lyria-3-clip-preview',
    aiMusicProModel: 'lyria-3-pro-preview',
  },
}));
jest.mock('../../db/client', () => ({ db: {} }));
jest.mock('../../storage/r2', () => ({ r2: {}, R2_BUCKET: 'test' }));
jest.mock('../../services/archivalService', () => ({ getUploadPresignedUrl: jest.fn() }));

import { fingerprintSnapshot, quoteSoundtrack, type SoundtrackProjectSnapshot } from '../../services/soundtrackService';

describe('AI Music quote and fingerprint', () => {
  it.each([
    [3, 'clip', 4],
    [30, 'clip', 4],
    [30.1, 'pro', 8],
    [184, 'pro', 8],
  ])('quotes %s seconds with the expected tier', (duration, tier, credits) => {
    expect(quoteSoundtrack(duration)).toMatchObject({
      supported: true,
      model_tier: tier,
      cost_credits: credits,
    });
  });

  it('rejects projects over the 3:04 limit', () => {
    expect(quoteSoundtrack(184.001)).toMatchObject({
      supported: false,
      maximum_duration_seconds: 184,
      reason: 'duration_too_long',
    });
  });

  it('fingerprints the complete deterministic snapshot', () => {
    const snapshot: SoundtrackProjectSnapshot = {
      version: 1,
      duration_seconds: 5,
      title: 'Test',
      clips: [{
        id: 'clip-1', type: 'video', sort_order: 0, timeline_start: 0, timeline_end: 5,
        trim_start: 1, trim_end: 6, r2_key: 'projects/test/clip.mp4',
      }],
    };
    expect(fingerprintSnapshot(snapshot)).toBe(fingerprintSnapshot(structuredClone(snapshot)));
    expect(fingerprintSnapshot({ ...snapshot, duration_seconds: 5.1 })).not.toBe(fingerprintSnapshot(snapshot));
  });
});
