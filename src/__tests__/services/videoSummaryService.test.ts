jest.mock('../../config', () => ({
  config: {
    geminiApiKey: 'test-key',
    videoSummaryModel: 'gemini-test',
    videoSummaryTextModel: 'gemini-text-test',
    videoSummaryWikipediaEnabled: true,
  },
}));

import {
  computeVideoSummaryCost,
  hasRequiredStoryCoverage,
  isUsableVerifiedEvidence,
  MAX_CANDIDATE_CLIP_SECONDS,
  MAX_PLAN_ARRAY_ITEMS,
  narrationAuditIssues,
  isOutputDurationProportionate,
  parseMotionMetadata,
  recommendedOutputSeconds,
  rankActionWindows,
  selectVerificationCandidates,
  validateGroundedNarration,
  validateVideoSummaryPlan,
  verificationBudget,
} from '../../services/videoSummaryService';
import type { VerifiedEvidence, VideoSummaryClip } from '../../services/videoSummaryService';

const PLOT_FIELDS = {
  characters: ['The student — protagonist', 'The dark-haired student — investigator'],
  causal_summary: 'A sealed object attracts a threat, forcing the students to confront it before the protagonist ends the immediate danger.',
  story_outline: [
    'The protagonist is introduced.',
    'A sealed object attracts the threat.',
    'The threat attacks the students.',
    'The protagonist stops the immediate danger.',
  ],
};

describe('selectVerificationCandidates', () => {
  // A planner run that over-returns front-loaded setup/cause options, exactly as the prompt asks.
  const CANDIDATES = [
    ...Array.from({ length: 10 }, (_, index) => ({
      clip: {
        startSeconds: index * 10,
        endSeconds: index * 10 + 4,
        description: `setup ${index}`,
        storyRole: index < 5 ? 'setup' as const : 'cause' as const,
        storyStepIndex: index < 5 ? 0 : 1,
      } satisfies VideoSummaryClip,
    })),
    { clip: { startSeconds: 400, endSeconds: 405, description: 'escalation', storyRole: 'escalation' as const, storyStepIndex: 2 } },
    { clip: { startSeconds: 500, endSeconds: 505, description: 'turn', storyRole: 'turning_point' as const, storyStepIndex: 3 } },
    { clip: { startSeconds: 600, endSeconds: 605, description: 'payoff', storyRole: 'payoff' as const, storyStepIndex: 4 } },
  ];

  it('keeps the ending instead of spending the whole budget on the front of the episode', () => {
    const selected = selectVerificationCandidates(CANDIDATES, 6);

    expect(selected).toHaveLength(6);
    expect(hasRequiredStoryCoverage(selected.map((candidate) => candidate.clip))).toBe(true);
    // The payoff is the LAST candidate chronologically — a prefix cut would have dropped it.
    expect(selected.some((candidate) => candidate.clip.storyRole === 'payoff')).toBe(true);
  });

  it('returns candidates in source order so downstream chronology holds', () => {
    const starts = selectVerificationCandidates(CANDIDATES, 8)
      .map((candidate) => candidate.clip.startSeconds);

    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('spends leftover budget widening story-step coverage before adding redundant clips', () => {
    const steps = new Set(selectVerificationCandidates(CANDIDATES, 5)
      .map((candidate) => candidate.clip.storyStepIndex));

    expect(steps.size).toBe(5);
  });

  it('passes everything through untouched when the budget is not binding', () => {
    expect(selectVerificationCandidates(CANDIDATES, 13)).toEqual(CANDIDATES);
    expect(selectVerificationCandidates(CANDIDATES, 99)).toEqual(CANDIDATES);
  });
});

describe('output-duration guidelines', () => {
  it('scales the recommended tier with source length', () => {
    expect(recommendedOutputSeconds(3 * 60)).toBe(30);
    expect(recommendedOutputSeconds(6 * 60)).toBe(30);
    expect(recommendedOutputSeconds(12 * 60)).toBe(60);
    expect(recommendedOutputSeconds(24 * 60)).toBe(90);
    expect(recommendedOutputSeconds(60 * 60)).toBe(90);
  });

  it('accepts any tier at or above the recommendation', () => {
    expect(isOutputDurationProportionate(24 * 60, 90).ok).toBe(true);
    expect(isOutputDurationProportionate(3 * 60, 90).ok).toBe(true);
    expect(isOutputDurationProportionate(12 * 60, 60).ok).toBe(true);
  });

  it('blocks only the extreme mismatch, and warns on the merely thin ask', () => {
    // An hour into 30s cannot be a summary in any useful sense.
    const blocked = isOutputDurationProportionate(60 * 60, 30);
    expect(blocked.ok).toBe(false);
    expect(blocked.severity).toBe('blocked');
    expect(blocked.recommendedSeconds).toBe(90);
    expect(blocked.message).toContain('60-minute');

    // One tier short is workable — the caller decides whether to surface it.
    const warned = isOutputDurationProportionate(12 * 60, 30);
    expect(warned.ok).toBe(false);
    expect(warned.severity).toBe('warn');

    // Two tiers short but only because the source sits just past the 90s threshold.
    expect(isOutputDurationProportionate(24 * 60, 60).severity).toBe('warn');
  });

  it('degrades to the shortest tier on an unusable source duration', () => {
    expect(recommendedOutputSeconds(0)).toBe(30);
    expect(recommendedOutputSeconds(Number.NaN)).toBe(30);
  });
});

describe('candidate clip length', () => {
  const planWith = (rangeSeconds: number) => validateVideoSummaryPlan({
    title: 'T', overview: 'O', music_mood: 'dramatic', ...PLOT_FIELDS,
    source_identity: { title: '', character_names: [], evidence_quotes: [], confidence: 0 },
    candidates: [
      { provisional_claim: 'a', start_timestamp: '00:10.000', end_timestamp: `00:${(10 + rangeSeconds).toFixed(3).padStart(6, '0')}`, description: 'a', editorial_role: 'setup', story_step_index: 0 },
      { provisional_claim: 'b', start_timestamp: '02:00.000', end_timestamp: '02:06.000', description: 'b', editorial_role: 'cause', story_step_index: 1 },
      { provisional_claim: 'c', start_timestamp: '03:00.000', end_timestamp: '03:06.000', description: 'c', editorial_role: 'escalation', story_step_index: 2 },
      { provisional_claim: 'd', start_timestamp: '04:00.000', end_timestamp: '04:06.000', description: 'd', editorial_role: 'payoff', story_step_index: 3 },
    ],
  }, 1000);

  it('caps an over-long candidate around its midpoint instead of trusting the prompt', () => {
    // Observed real behaviour: the planner returns 21s/16s/15s clips against a stated 8s maximum.
    const clip = planWith(21).beats[0]!.clips[0]!;

    expect(clip.endSeconds - clip.startSeconds).toBeCloseTo(MAX_CANDIDATE_CLIP_SECONDS, 5);
    // Centred on the original 10-31s range, so the kept seconds are the middle of what was chosen.
    expect((clip.startSeconds + clip.endSeconds) / 2).toBeCloseTo(20.5, 5);
  });

  it('leaves a compliant clip untouched', () => {
    const clip = planWith(6).beats[0]!.clips[0]!;

    expect(clip.startSeconds).toBeCloseTo(10, 5);
    expect(clip.endSeconds).toBeCloseTo(16, 5);
  });
});

describe('verificationBudget', () => {
  it('supplies enough surviving footage to fill every tier at natural speed', () => {
    // The cut plays clips at 1x, so each tier needs ~0.9x its runtime in VERIFIED footage. With a
    // ~6s working clip and verification legitimately rejecting some, the budget has to cover both.
    for (const tier of [30, 60, 90]) {
      const survivingSeconds = verificationBudget(tier) * 0.75 * 6;
      expect(survivingSeconds).toBeGreaterThanOrEqual(tier * 0.9);
    }
  });

  it('scales with the tier rather than sitting at a flat cap', () => {
    expect(verificationBudget(90)).toBeGreaterThan(verificationBudget(60));
    expect(verificationBudget(60)).toBeGreaterThan(verificationBudget(30));
  });

  it('stays inside the schema ceiling and degrades safely', () => {
    // The response schema declares maxItems: MAX_PLAN_ARRAY_ITEMS, and this API rejects the whole
    // request (bare 400, no field named) one above that — so the ask must never exceed the cap.
    expect(MAX_PLAN_ARRAY_ITEMS).toBe(22);
    expect(verificationBudget(90)).toBeLessThanOrEqual(MAX_PLAN_ARRAY_ITEMS);
    expect(verificationBudget(600)).toBeLessThanOrEqual(MAX_PLAN_ARRAY_ITEMS);
    expect(verificationBudget(0)).toBe(14);
    expect(verificationBudget(Number.NaN)).toBe(14);
  });
});

describe('validateGroundedNarration', () => {
  const evidence = (id: string, startSeconds: number, storyRole: VideoSummaryClip['storyRole'], storyStepIndex: number): VerifiedEvidence => ({
    id,
    clip: { startSeconds, endSeconds: startSeconds + 15, description: id, storyRole, storyStepIndex },
    visualFacts: [`${id} is visible`],
    spokenFacts: [],
    confidence: 0.9,
  });
  const EVIDENCE = [
    evidence('e1', 0, 'setup', 0),
    evidence('e2', 100, 'cause', 1),
    evidence('e3', 200, 'escalation', 2),
    evidence('e4', 300, 'payoff', 3),
  ];

  it('skips a beat whose evidence ids were all already spent, instead of failing the run', () => {
    const plan = validateGroundedNarration({
      title: 'A recap', overview: 'Overview.', music_mood: 'dramatic',
      beats: [
        { narration: 'Setup.', evidence_ids: ['e1'] },
        { narration: 'Cause.', evidence_ids: ['e2'] },
        // Reuses an id already consumed above — one narrator slip must not kill the whole job.
        { narration: 'Repeat.', evidence_ids: ['e1'] },
        { narration: 'It escalates.', evidence_ids: ['e3'] },
        { narration: 'Payoff.', evidence_ids: ['e4'] },
      ],
    }, EVIDENCE, 60);

    expect(plan.beats.map((beat) => beat.narration)).toEqual(['Setup.', 'Cause.', 'It escalates.', 'Payoff.']);
  });

  it('still rejects genuinely out-of-order evidence in strict mode', () => {
    expect(() => validateGroundedNarration({
      title: 'A recap', overview: 'Overview.', music_mood: 'dramatic',
      beats: [
        { narration: 'Payoff first.', evidence_ids: ['e4'] },
        { narration: 'Setup after.', evidence_ids: ['e1'] },
      ],
    }, EVIDENCE, 60)).toThrow('non-chronological');
  });

  it('lenient mode drops the out-of-order beat and salvages the run', () => {
    // Same out-of-order input, but the final (lenient) attempt keeps the payoff and drops the
    // backward-reaching setup beat rather than failing the whole generation.
    const plan = validateGroundedNarration({
      title: 'A recap', overview: 'Overview.', music_mood: 'dramatic',
      beats: [
        { narration: 'Setup.', evidence_ids: ['e1'] },
        { narration: 'Cause.', evidence_ids: ['e2'] },
        { narration: 'Backward jump.', evidence_ids: ['e1b'] }, // starts before e2 ends → dropped
        { narration: 'Escalation.', evidence_ids: ['e3'] },
        { narration: 'Payoff.', evidence_ids: ['e4'] },
      ],
    }, [...EVIDENCE, evidence('e1b', 50, 'setup', 0)], 60, true);
    expect(plan.beats.map((b) => b.narration)).toEqual(['Setup.', 'Cause.', 'Escalation.', 'Payoff.']);
  });
});

describe('videoSummaryService pure contracts', () => {
  it('parses dense ffmpeg frame-difference metadata', () => {
    expect(parseMotionMetadata([
      'frame:0 pts:0 pts_time:0',
      'lavfi.signalstats.YDIF=0',
      'frame:1 pts:1 pts_time:0.5',
      'lavfi.signalstats.YDIF=24.75',
    ].join('\n'))).toEqual([
      { timeSeconds: 0, difference: 0 },
      { timeSeconds: 0.5, difference: 24.75 },
    ]);
  });

  it('returns chronological non-overlapping action windows ranked relative to the source', () => {
    const samples = Array.from({ length: 80 }, (_, index) => ({
      timeSeconds: index * 0.5,
      difference: index >= 32 && index < 48 ? 40 : 2,
    }));
    const windows = rankActionWindows(samples, 40, 3);

    expect(windows).toHaveLength(3);
    expect(windows.map((window) => window.startSeconds)).toEqual(
      [...windows.map((window) => window.startSeconds)].sort((a, b) => a - b),
    );
    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index]!.startSeconds).toBeGreaterThanOrEqual(windows[index - 1]!.endSeconds - 1);
    }
    expect(Math.max(...windows.map((window) => window.actionScore))).toBe(100);
  });

  it('prices by measured source minutes plus requested output seconds', () => {
    expect(computeVideoSummaryCost(24 * 60, 60)).toBe(88);
    expect(computeVideoSummaryCost(10, 30)).toBe(59);
    expect(computeVideoSummaryCost(24 * 60, 60, false)).toBe(84);
    expect(() => computeVideoSummaryCost(0, 60)).toThrow('Invalid source duration');
  });

  it('keeps clear verified footage even when its provisional retrieval claim is too broad', () => {
    expect(isUsableVerifiedEvidence({
      eventMatchesClaim: false,
      visuallyClear: true,
      confidence: 0.8,
      visualFacts: ['A boy crashes through a window.'],
      spokenFacts: [],
    })).toBe(true);
    expect(isUsableVerifiedEvidence({
      eventMatchesClaim: true,
      visuallyClear: false,
      confidence: 0.9,
      visualFacts: ['A blurry shape moves.'],
      spokenFacts: [],
    })).toBe(false);
    expect(isUsableVerifiedEvidence({
      eventMatchesClaim: true,
      visuallyClear: false,
      confidence: 0.9,
      visualFacts: [],
      spokenFacts: ['Opening the seal will attract the creatures.'],
    })).toBe(true);
  });

  it('rejects a held shot of nothing, but keeps a quiet shot that has a subject or dialogue', () => {
    // Dead air: nothing moves, nobody on screen. This is the "still, nothing happening" footage
    // that makes a recap feel slow even when the range is technically well described.
    expect(isUsableVerifiedEvidence({
      eventMatchesClaim: true,
      visuallyClear: true,
      subjectInFrame: false,
      staticShot: true,
      confidence: 0.9,
      visualFacts: ['An empty classroom at dusk.'],
      spokenFacts: [],
    })).toBe(false);

    // Static but occupied — a person talking or reacting still carries the story.
    expect(isUsableVerifiedEvidence({
      eventMatchesClaim: true,
      visuallyClear: true,
      subjectInFrame: true,
      staticShot: true,
      confidence: 0.9,
      visualFacts: ['An old man lies in a hospital bed.'],
      spokenFacts: [],
    })).toBe(true);

    // Empty and static, but the dialogue is doing the narrative work — keeping this is what stops
    // the filter from stripping out the quiet cause/exposition beats the story needs.
    expect(isUsableVerifiedEvidence({
      eventMatchesClaim: true,
      visuallyClear: false,
      subjectInFrame: false,
      staticShot: true,
      confidence: 0.9,
      visualFacts: [],
      spokenFacts: ['Opening the seal will attract the creatures.'],
    })).toBe(true);

    // Absent flags (older payloads) must not start rejecting evidence.
    expect(isUsableVerifiedEvidence({
      eventMatchesClaim: true,
      visuallyClear: true,
      confidence: 0.9,
      visualFacts: ['A boy runs down a hallway.'],
      spokenFacts: [],
    })).toBe(true);
  });

  it('requires setup, cause, escalation or turning point, and payoff across distinct story steps', () => {
    expect(hasRequiredStoryCoverage([
      { startSeconds: 0, endSeconds: 2, description: 'intro', storyRole: 'setup', storyStepIndex: 0 },
      { startSeconds: 2, endSeconds: 4, description: 'trigger', storyRole: 'cause', storyStepIndex: 1 },
      { startSeconds: 4, endSeconds: 6, description: 'attack', storyRole: 'escalation', storyStepIndex: 2 },
      { startSeconds: 6, endSeconds: 8, description: 'result', storyRole: 'payoff', storyStepIndex: 3 },
    ])).toBe(true);
    expect(hasRequiredStoryCoverage([
      { startSeconds: 0, endSeconds: 2, description: 'intro', storyRole: 'setup', storyStepIndex: 0 },
      { startSeconds: 2, endSeconds: 4, description: 'fight', storyRole: 'escalation', storyStepIndex: 2 },
      { startSeconds: 4, endSeconds: 6, description: 'result', storyRole: 'payoff', storyStepIndex: 3 },
    ])).toBe(false);
  });

  it('normalizes a valid plan into chronological typed beats', () => {
    const plan = validateVideoSummaryPlan({
      title: 'John is saved',
      overview: 'A rescue arc',
      music_mood: 'dramatic',
      source_identity: {
        title: 'Example Show',
        character_names: ['John'],
        evidence_quotes: ['John is trapped'],
        confidence: 0.94,
      },
      beats: [
        {
          narration: 'The rescue finally arrives.',
          clips: [{ start_seconds: 50, end_seconds: 55, description: 'rescue' }],
        },
        {
          narration: 'John is trapped.',
          clips: [{ start_seconds: 10, end_seconds: 14, description: 'setup' }],
        },
      ],
    }, 120);

    expect(plan.musicMood).toBe('dramatic');
    expect(plan.beats.map((beat) => beat.clips[0]!.startSeconds)).toEqual([10, 50]);
    expect(plan.sourceIdentity).toEqual({
      title: 'Example Show',
      characterNames: ['John'],
      evidenceQuotes: ['John is trapped'],
      confidence: 0.94,
    });
  });

  it('normalizes the flattened Gemini candidate schema into verification beats', () => {
    const plan = validateVideoSummaryPlan({
      title: 'Blind summary',
      overview: 'A chronological arc',
      music_mood: 'dramatic',
      source_identity: {
        title: '',
        character_names: [],
        evidence_quotes: [],
        confidence: 0.2,
      },
      ...PLOT_FIELDS,
      candidates: [
        { provisional_claim: 'The immediate danger ends.', start_timestamp: '00:40.000', end_timestamp: '00:45.000', description: 'result', editorial_role: 'payoff', story_step_index: 3 },
        { provisional_claim: 'The threat attacks.', start_timestamp: '00:30.000', end_timestamp: '00:35.000', description: 'threat', editorial_role: 'escalation', story_step_index: 2 },
        { provisional_claim: 'The student is introduced.', start_timestamp: '00:10.000', end_timestamp: '00:15.000', description: 'introduction', editorial_role: 'setup', story_step_index: 0 },
        { provisional_claim: 'The seal draws the threat.', start_timestamp: '00:20.000', end_timestamp: '00:25.000', description: 'cause', editorial_role: 'cause', story_step_index: 1 },
      ],
    }, 120);

    expect(plan.beats.map((beat) => beat.clips[0]!.startSeconds)).toEqual([10, 20, 30, 40]);
    expect(plan.plotUnderstanding).toEqual({
      characters: PLOT_FIELDS.characters,
      causalSummary: PLOT_FIELDS.causal_summary,
      storyOutline: PLOT_FIELDS.story_outline,
    });
  });

  it('rejects a plan when removing overlaps leaves too little usable footage', () => {
    expect(() => validateVideoSummaryPlan({
      title: 'Bad plan',
      overview: 'overlap',
      music_mood: 'ambient',
      beats: [
        { narration: 'One', clips: [{ start_seconds: 5, end_seconds: 12, description: 'one' }] },
        { narration: 'Two', clips: [{ start_seconds: 10, end_seconds: 15, description: 'two' }] },
      ],
    }, 30)).toThrow('too few usable beats');
  });

  it('drops a duplicate overlapping candidate when enough chronological footage remains', () => {
    const plan = validateVideoSummaryPlan({
      title: 'Recoverable plan',
      overview: 'one duplicate',
      music_mood: 'dramatic',
      ...PLOT_FIELDS,
      candidates: [
        { provisional_claim: 'Setup', start_timestamp: '00:01.000', end_timestamp: '00:05.000', description: 'setup', editorial_role: 'setup', story_step_index: 0 },
        { provisional_claim: 'Duplicate', start_timestamp: '00:04.000', end_timestamp: '00:07.000', description: 'overlap', editorial_role: 'setup', story_step_index: 0 },
        { provisional_claim: 'Cause', start_timestamp: '00:08.000', end_timestamp: '00:12.000', description: 'cause', editorial_role: 'cause', story_step_index: 1 },
        { provisional_claim: 'Escalation', start_timestamp: '00:14.000', end_timestamp: '00:18.000', description: 'attack', editorial_role: 'escalation', story_step_index: 2 },
        { provisional_claim: 'Payoff', start_timestamp: '00:20.000', end_timestamp: '00:26.000', description: 'payoff', editorial_role: 'payoff', story_step_index: 3 },
      ],
    }, 30);

    expect(plan.beats.map((beat) => beat.narration)).toEqual(['Setup', 'Cause', 'Escalation', 'Payoff']);
  });

  it('rejects an action-only candidate plan that omits the cause of the conflict', () => {
    expect(() => validateVideoSummaryPlan({
      title: 'Action reel',
      overview: 'Fights without context',
      music_mood: 'dramatic',
      ...PLOT_FIELDS,
      candidates: [
        { provisional_claim: 'A student appears.', start_timestamp: '00:01.000', end_timestamp: '00:05.000', description: 'intro', editorial_role: 'setup', story_step_index: 0 },
        { provisional_claim: 'A creature attacks.', start_timestamp: '00:08.000', end_timestamp: '00:12.000', description: 'attack', editorial_role: 'escalation', story_step_index: 2 },
        { provisional_claim: 'The fight continues.', start_timestamp: '00:14.000', end_timestamp: '00:18.000', description: 'fight', editorial_role: 'turning_point', story_step_index: 2 },
        { provisional_claim: 'The creature falls.', start_timestamp: '00:20.000', end_timestamp: '00:24.000', description: 'result', editorial_role: 'payoff', story_step_index: 3 },
      ],
    }, 30)).toThrow('causal story coverage');
  });

  it('fails a narration audit when a beat is missing or contains unsupported plot', () => {
    expect(narrationAuditIssues({
      approved: false,
      beat_reviews: [{
        beat_index: 0,
        supported: false,
        unsupported_claims: ['claims John planned the rescue'],
      }],
    }, 2)).toEqual([
      'Beat 1: claims John planned the rescue',
      'Beat 2 was not audited',
    ]);
  });

  it('accepts a narration audit only when every beat is explicitly supported', () => {
    expect(narrationAuditIssues({
      approved: true,
      beat_reviews: [
        { beat_index: 0, supported: true, unsupported_claims: [] },
        { beat_index: 1, supported: true, unsupported_claims: [] },
      ],
    }, 2)).toEqual([]);
  });
});
