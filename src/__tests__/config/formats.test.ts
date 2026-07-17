import {
  CLIENT_FORMATS,
  SERVER_FORMATS,
  type FormatSegmentType,
} from '../../config/formats';

describe('formats registry config', () => {
  it('strips every server-only field from every client row', () => {
    const serverOnlyFields = [
      'script_template',
      'image_model',
      'omni_model',
      'tts_model',
      'music_model',
      'candidate_still_count',
    ];

    for (const format of CLIENT_FORMATS) {
      for (const field of serverOnlyFields) {
        expect(format).not.toHaveProperty(field);
      }
      for (const style of format.style_grid) {
        expect(style).not.toHaveProperty('anchor_r2_key');
      }
    }

    const serialized = JSON.stringify(CLIENT_FORMATS);
    for (const field of [...serverOnlyFields, 'anchor_r2_key']) {
      expect(serialized).not.toContain(field);
    }
  });

  it('retains every field required by the client format sheet', () => {
    const explainer = CLIENT_FORMATS.find((format) => format.format_id === 'explainer');

    expect(explainer?.sheet.preparing_label).toBe('Writing your script…');
    expect(explainer?.sheet.description).toBeTruthy();
    expect(explainer?.duration_tiers.map((tier) => tier.credits)).toEqual([
      325, 470, 693, 930, 1377,
    ]);
    expect(explainer?.voices).toHaveLength(6);
    expect(explainer?.music_moods).toEqual(
      expect.arrayContaining(['auto', 'uplifting', 'ambient', 'dramatic', 'playful', 'none']),
    );
    expect(explainer?.aspect_ratios).toEqual(['9:16', '16:9']);
    for (const style of explainer?.style_grid ?? []) {
      expect(style.id).toBeTruthy();
      expect(style.label).toBeTruthy();
      expect(style.thumb_url).toBeTruthy();
    }
  });

  it('defines five strictly increasing fal-priced duration tiers', () => {
    const explainer = SERVER_FORMATS.find((format) => format.format_id === 'explainer');
    const tiers = explainer?.duration_tiers ?? [];

    expect(tiers).toHaveLength(5);
    expect(tiers.map((tier) => tier.seconds)).toEqual([20, 30, 45, 60, 90]);
    expect(tiers.map((tier) => tier.credits)).toEqual([325, 470, 693, 930, 1377]);
    for (let index = 1; index < tiers.length; index += 1) {
      expect(tiers[index]!.credits).toBeGreaterThan(tiers[index - 1]!.credits);
    }
  });

  it('offers only the two aspect ratios supported by Omni', () => {
    const explainer = SERVER_FORMATS.find((format) => format.format_id === 'explainer');
    expect(explainer?.aspect_ratios).toEqual(['9:16', '16:9']);
  });

  it('supports formats-ready segment types while Explainer uses dialogue only', () => {
    const segmentTypes: FormatSegmentType[] = ['dialogue', 'vocab', 'drill'];
    const explainer = SERVER_FORMATS.find((format) => format.format_id === 'explainer');

    expect(segmentTypes).toEqual(['dialogue', 'vocab', 'drill']);
    expect(explainer?.script_template.segment_types_allowed).toEqual(['dialogue']);
    expect(explainer?.style_grid).toHaveLength(6);
  });
});
