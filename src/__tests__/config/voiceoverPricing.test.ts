import { AUDIO_VOICES, CLIENT_AUDIO_VOICES, VoiceKind } from '../../config/audioVoices';
import {
  quoteVoiceover,
  VOICEOVER_PRICING,
  VOICEOVER_PRICING_VERSION,
} from '../../config/voiceoverPricing';

describe('AUDIO_VOICES roster', () => {
  it('seeds Gemini preset voices and the system clone voiceA', () => {
    const ids = AUDIO_VOICES.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(['kore', 'voiceA']));
    expect(AUDIO_VOICES.find((v) => v.id === 'voiceA')?.kind).toBe('system_clone');
  });

  it('exposes only safe public fields to the client projection', () => {
    const serialized = JSON.stringify(CLIENT_AUDIO_VOICES);
    expect(serialized).not.toContain('referenceR2Key');
    expect(serialized).not.toContain('referenceText');
    expect(serialized).not.toContain('provider');
    expect(serialized).not.toContain('model');
    expect(serialized).not.toContain('speaker');
    expect(serialized).not.toContain('transcript');
  });

  it('never labels the system clone as My Voice', () => {
    const voiceA = AUDIO_VOICES.find((v) => v.id === 'voiceA');
    expect(voiceA).toBeDefined();
    expect(voiceA!.label.toLowerCase()).not.toContain('my voice');
  });
});

describe('quoteVoiceover', () => {
  it('rejects an unknown voice id', () => {
    expect(() =>
      quoteVoiceover({ voiceId: 'not-a-voice', scriptCharacters: 100 }),
    ).toThrow('Unknown voice');
  });

  it('rejects zero characters', () => {
    expect(() => quoteVoiceover({ voiceId: 'kore', scriptCharacters: 0 })).toThrow(
      'scriptCharacters',
    );
  });

  it('rejects more than 5000 characters', () => {
    expect(() => quoteVoiceover({ voiceId: 'kore', scriptCharacters: 5001 })).toThrow(
      'scriptCharacters',
    );
  });

  describe('preset voices (Chirp 3 HD / Gemini preset rate)', () => {
    const voiceId = 'kore';
    const rate = VOICEOVER_PRICING.presetCentsPerCharacter;

    it('costs 1 credit for the minimum floor at 1 character', () => {
      const q = quoteVoiceover({ voiceId, scriptCharacters: 1 });
      expect(q.estimated_provider_cents).toBeCloseTo(rate, 6);
      expect(q.cost_credits).toBe(1);
      expect(q.pricing_version).toBe(VOICEOVER_PRICING_VERSION);
    });

    it('costs 1 credit at the tier boundary (333 characters)', () => {
      const q = quoteVoiceover({ voiceId, scriptCharacters: 333 });
      expect(q.estimated_provider_cents).toBeCloseTo(333 * rate, 6);
      expect(q.cost_credits).toBe(1);
    });

    it('costs 2 credits just above the tier boundary (334 characters)', () => {
      const q = quoteVoiceover({ voiceId, scriptCharacters: 334 });
      expect(q.estimated_provider_cents).toBeCloseTo(334 * rate, 6);
      expect(q.cost_credits).toBe(2);
    });

    it('costs 15 credits at the maximum 5000 characters', () => {
      const q = quoteVoiceover({ voiceId, scriptCharacters: 5000 });
      expect(q.estimated_provider_cents).toBeCloseTo(5000 * rate, 6);
      expect(q.cost_credits).toBe(15);
    });
  });

  describe('system clone voices (qwen voice_clone rate)', () => {
    const voiceId = 'voiceA';
    const rate = VOICEOVER_PRICING.cloneCentsPerCharacter;

    it('costs 1 credit for the minimum floor at 1 character', () => {
      const q = quoteVoiceover({ voiceId, scriptCharacters: 1 });
      expect(q.estimated_provider_cents).toBeCloseTo(rate, 6);
      expect(q.cost_credits).toBe(1);
    });

    it('costs 1 credit at the tier boundary (500 characters)', () => {
      const q = quoteVoiceover({ voiceId, scriptCharacters: 500 });
      expect(q.estimated_provider_cents).toBeCloseTo(500 * rate, 6);
      expect(q.cost_credits).toBe(1);
    });

    it('costs 2 credits just above the tier boundary (501 characters)', () => {
      const q = quoteVoiceover({ voiceId, scriptCharacters: 501 });
      expect(q.estimated_provider_cents).toBeCloseTo(501 * rate, 6);
      expect(q.cost_credits).toBe(2);
    });

    it('costs 10 credits at the maximum 5000 characters', () => {
      const q = quoteVoiceover({ voiceId, scriptCharacters: 5000 });
      expect(q.estimated_provider_cents).toBeCloseTo(5000 * rate, 6);
      expect(q.cost_credits).toBe(10);
    });
  });
});
