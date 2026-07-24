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
    ];

    for (const format of CLIENT_FORMATS) {
      for (const field of serverOnlyFields) {
        expect(format).not.toHaveProperty(field);
      }
      if (format.status === 'live' && !('flow' in format)) {
        for (const style of format.style_grid) {
          expect(style).not.toHaveProperty('anchor_r2_key');
        }
      }
    }

    const serialized = JSON.stringify(CLIENT_FORMATS);
    for (const field of [...serverOnlyFields, 'anchor_r2_key']) {
      expect(serialized).not.toContain(field);
    }
  });

  it('retains every field required by the client format sheet', () => {
    const explainer = CLIENT_FORMATS.find((format) => format.format_id === 'explainer');
    if (!explainer || explainer.status !== 'live' || 'flow' in explainer) throw new Error('live explainer missing');

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
    if (!explainer || explainer.status !== 'live' || 'flow' in explainer) throw new Error('live explainer missing');
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
    if (!explainer || explainer.status !== 'live' || 'flow' in explainer) throw new Error('live explainer missing');
    expect(explainer?.aspect_ratios).toEqual(['9:16', '16:9']);
  });

  it('supports formats-ready segment types while Explainer uses dialogue only', () => {
    const segmentTypes: FormatSegmentType[] = ['dialogue', 'vocab', 'drill'];
    const explainer = SERVER_FORMATS.find((format) => format.format_id === 'explainer');
    if (!explainer || explainer.status !== 'live' || 'flow' in explainer) throw new Error('live explainer missing');

    expect(segmentTypes).toEqual(['dialogue', 'vocab', 'drill']);
    expect(explainer?.script_template.segment_types_allowed).toEqual(['dialogue']);
    expect(explainer?.style_grid).toHaveLength(7);
  });

  it('publishes the Video Summarizer upload flow with narrator and measured pricing choices', () => {
    const format = CLIENT_FORMATS.find((row) => row.format_id === 'video-explainer');
    if (!format || format.status !== 'live' || !('flow' in format)) {
      throw new Error('live Video Summarizer missing');
    }

    expect(format.flow).toBe('video_summary');
    expect(format.output_durations).toEqual([30, 60, 90]);
    expect(format.aspect_ratios).toEqual(['9:16', '1:1', '16:9']);
    expect(format.voices).toHaveLength(6);
    expect(format.voice_default).toBe('Kore');
    expect(format.pricing).toEqual({
      source_minute_credits: 1,
      output_second_credits: 1,
      minimum_credits: 55,
      music_credits: 4,
    });
  });

  it('publishes three presentation-only SOON teasers without pipeline or pricing fields', () => {
    const teasers = CLIENT_FORMATS.filter((format) => format.status === 'soon');

    expect(teasers.map((format) => format.format_id)).toEqual([
      'daily-verse',
      'spanish-lessons',
      'history-reimagined',
    ]);
    for (const teaser of teasers) {
      expect(teaser.title).toBeTruthy();
      expect(teaser.subtitle).toBeTruthy();
      expect(teaser.tile).toBeDefined();
      expect(teaser).not.toHaveProperty('script_template');
      expect(teaser).not.toHaveProperty('duration_tiers');
      expect(teaser).not.toHaveProperty('style_grid');
    }
  });
});
