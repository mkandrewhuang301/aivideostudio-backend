jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn(), close: jest.fn() })),
  Worker: jest.fn().mockImplementation(() => ({ close: jest.fn(), on: jest.fn() })),
}));

const mockConfig = { videoSummaryDiegeticEnabled: false };
jest.mock('../../config', () => ({ config: mockConfig }));

jest.mock('../../config/formats', () => ({
  FORMATS_BY_ID: {
    explainer: {
      tts_model: 'gemini-tts-test',
      music_model: 'lyria-test',
      caption_style: {
        fontSize: 52,
        textColor: '#FFFFFF',
        highlightColor: '#FFD166',
        position: 'bottom',
      },
    },
  },
}));

jest.mock('../../services/videoSummaryService', () => ({
  analyzeActionWindows: jest.fn(),
  extractEmbeddedSubtitleText: jest.fn(),
  planVideoSummary: jest.fn(),
}));
jest.mock('../../services/archivalService', () => ({
  getUploadPresignedUrl: jest.fn(),
  getGenerationPresignedUrl: jest.fn(),
  uploadBufferToR2: jest.fn(),
}));
jest.mock('../../services/geminiTtsService', () => ({
  generateNarrationForScene: jest.fn(),
  // The worker imports these shared voice constants from the service — the mock must provide
  // them or the clone branch presigns `undefined` and the style prompt is lost.
  VOICE_A_REFERENCE_R2_KEY: 'reference-voices/voiceA-clipA.mp3',
  VOICE_A_TRANSCRIPT: 'Mary looked for an opportunity to strike the crystal horn rabbit.',
  VIDEO_SUMMARY_VOICE_STYLE_PROMPT: 'Narrate with a brisk, energetic pace.',
}));
jest.mock('../../services/lyriaService', () => ({ generateMusicBed: jest.fn() }));
jest.mock('../../services/mediaProbe', () => ({ probeVideoMeta: jest.fn(), probeHasAudioStream: jest.fn() }));
jest.mock('../../services/providers/ReplicateProvider', () => ({ transcribeWordTimings: jest.fn() }));
jest.mock('../../services/whisperxService', () => ({
  ...jest.requireActual('../../services/whisperxService'),
  getWordTimings: jest.fn(),
}));
jest.mock('../../services/wavUtil', () => ({
  concatWavBuffers: jest.fn(),
  silenceWav: jest.fn(),
  wavDurationSeconds: jest.fn(),
}));
jest.mock('../../services/generationService', () => ({
  classifyFailureReason: jest.fn(() => 'generic_error'),
  markFailed: jest.fn(),
  markProcessing: jest.fn(),
  mergeGenerationParams: jest.fn(),
}));
jest.mock('../../services/creditService', () => ({ refundCredits: jest.fn() }));

const ffmpegAdd = jest.fn();
jest.mock('../../queue/ffmpegWorker', () => ({
  ffmpegQueue: { add: ffmpegAdd },
}));

import {
  allocateSummaryClipDurations,
  diegeticHighlightSeconds,
  processVideoSummary,
  resolveSummaryCaptionAnchor,
  VIDEO_SUMMARY_NARRATION_TEMPO,
} from '../../queue/videoSummaryWorker';
import { probeHasAudioStream, probeVideoMeta } from '../../services/mediaProbe';
import {
  analyzeActionWindows,
  extractEmbeddedSubtitleText,
  planVideoSummary,
} from '../../services/videoSummaryService';
import {
  getUploadPresignedUrl,
  getGenerationPresignedUrl,
  uploadBufferToR2,
} from '../../services/archivalService';
import { generateNarrationForScene } from '../../services/geminiTtsService';
import { generateMusicBed } from '../../services/lyriaService';
import { getWordTimings } from '../../services/whisperxService';
import { concatWavBuffers, silenceWav, wavDurationSeconds } from '../../services/wavUtil';
import {
  markFailed,
  markProcessing,
  mergeGenerationParams,
} from '../../services/generationService';
import { refundCredits } from '../../services/creditService';
import type { VideoSummaryJob } from '../../queue/videoSummaryQueue';

const JOB: VideoSummaryJob = {
  generationId: 'gen-summary-1',
  userId: 'user-1',
  cost: 252,
  sourceR2Key: 'uploads/user-1/episode.mp4',
  sourceMimeType: 'video/mp4',
  sourceDurationSeconds: 1440,
  mode: 'theme',
  theme: 'John gets saved',
  context: 'John is the pilot. He is separated from his team.',
  outputDurationSeconds: 60,
  aspectRatio: '9:16',
  voiceId: 'Kore',
  includeMusic: true,
};

const PLAN = {
  title: 'John is saved',
  overview: 'A rescue under pressure.',
  musicMood: 'dramatic' as const,
  plotUnderstanding: {
    characters: ['John — stranded pilot', 'The rescue team — John\'s allies'],
    causalSummary: 'John becomes trapped, so his team mounts a rescue and pulls him free.',
    storyOutline: [
      'John is introduced as a pilot.',
      'John becomes trapped.',
      'His team reaches him.',
      'The team pulls John free.',
    ],
  },
  sourceKnowledge: {
    source: 'wikipedia' as const,
    title: 'Example Show',
    summary: 'A team of pilots faces dangerous rescues.',
    url: 'https://en.wikipedia.org/wiki/Example_Show',
    confidence: 0.96,
    allowedCharacterNames: ['John'],
    matchedSignals: ['title_in_source_text'],
  },
  beats: [
    {
      narration: 'John is trapped with no way out.',
      clips: [{ startSeconds: 10, endSeconds: 14, description: 'John trapped' }],
    },
    {
      narration: 'At the last second, his team pulls him free.',
      clips: [
        { startSeconds: 30, endSeconds: 33, description: 'team arrives' },
        { startSeconds: 33, endSeconds: 37, description: 'rescue' },
      ],
    },
  ],
};

const WORDS = [
  'John', 'is', 'trapped', 'with', 'no', 'way', 'out.',
  'At', 'the', 'last', 'second,', 'his', 'team', 'pulls', 'him', 'free.',
].map((text, index) => ({ text, startSeconds: index * 0.5, endSeconds: (index + 1) * 0.5 }));

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.videoSummaryDiegeticEnabled = false;
  ffmpegAdd.mockResolvedValue(undefined);
  (markProcessing as jest.Mock).mockResolvedValue(true);
  (markFailed as jest.Mock).mockResolvedValue(true);
  (mergeGenerationParams as jest.Mock).mockResolvedValue(undefined);
  (refundCredits as jest.Mock).mockResolvedValue(undefined);
  (getUploadPresignedUrl as jest.Mock).mockResolvedValue('https://r2.example.com/episode.mp4');
  (getGenerationPresignedUrl as jest.Mock).mockImplementation((key: string) => Promise.resolve(`https://r2.example.com/${key}`));
  (analyzeActionWindows as jest.Mock).mockResolvedValue([
    { startSeconds: 8, endSeconds: 16, actionScore: 90, meanMotion: 30, peakMotion: 45, cutDensity: 1 },
  ]);
  (extractEmbeddedSubtitleText as jest.Mock).mockResolvedValue('1\n00:00:08,000 --> 00:00:12,000\nJohn is trapped.');
  (planVideoSummary as jest.Mock).mockResolvedValue(PLAN);
  (generateNarrationForScene as jest.Mock)
    .mockResolvedValueOnce({ r2Key: 'generations/gen-summary-1.narration.0.wav', durationSeconds: 4 })
    .mockResolvedValueOnce({ r2Key: 'generations/gen-summary-1.narration.1.wav', durationSeconds: 6.25 });
  (concatWavBuffers as jest.Mock).mockReturnValue(Buffer.from('combined wav'));
  (uploadBufferToR2 as jest.Mock).mockResolvedValue(undefined);
  (getWordTimings as jest.Mock).mockResolvedValue(WORDS);
  (generateMusicBed as jest.Mock).mockResolvedValue({ r2Key: 'generations/gen-summary-1.music.wav' });
  (probeVideoMeta as jest.Mock).mockResolvedValue({ durationSeconds: 1440, width: 1920, height: 1080 });
  (probeHasAudioStream as jest.Mock).mockResolvedValue(true);
  (silenceWav as jest.Mock).mockImplementation((durationSeconds: number) => Buffer.from(`silence-${durationSeconds}`));
  (wavDurationSeconds as jest.Mock).mockImplementation((buffer: Buffer) => {
    const match = buffer.toString('utf8').match(/^silence-([\d.]+)/);
    return match ? Number(match[1]) : 0;
  });
  global.fetch = jest.fn().mockImplementation((url: string) => {
    if (url.includes('episode.mp4')) return Promise.resolve(new Response(Buffer.from('source video'), { status: 200 }));
    return Promise.resolve(new Response(Buffer.from('narration wav'), { status: 200 }));
  }) as jest.Mock;
});

describe('videoSummaryWorker', () => {
  it('allocates each beat exactly to measured narration duration', () => {
    expect(allocateSummaryClipDurations(PLAN.beats[1]!.clips, 7)).toEqual([
      { startSeconds: 30, endSeconds: 33, outputDurationSeconds: 3 },
      { startSeconds: 33, endSeconds: 37, outputDurationSeconds: 4 },
    ]);
  });

  it('extends the source range instead of slowing footage when narration runs longer', () => {
    expect(allocateSummaryClipDurations([
      { startSeconds: 100, endSeconds: 108, description: 'action' },
    ], 10, 200)).toEqual([
      { startSeconds: 100, endSeconds: 110, outputDurationSeconds: 10 },
    ]);
  });

  it('trims excess footage symmetrically instead of speeding it up', () => {
    expect(allocateSummaryClipDurations([
      { startSeconds: 100, endSeconds: 110, description: 'action' },
    ], 6.5)).toEqual([
      { startSeconds: 101.75, endSeconds: 108.25, outputDurationSeconds: 6.5 },
    ]);
  });

  describe('resolveSummaryCaptionAnchor', () => {
    const PORTRAIT = { width: 1080, height: 1920 };

    it('places the caption in the black band just below the square, not over the footage', () => {
      // Square top at y=180 → lower edge y=1260; caption 100px below → y=1360, in the black.
      const anchor = resolveSummaryCaptionAnchor({ canvas: PORTRAIT, squareTopPx: 180 })!;
      expect(anchor * PORTRAIT.height).toBeCloseTo(1360, 5);
      // Genuinely below the footage (the square's lower edge), i.e. in the black.
      expect(anchor * PORTRAIT.height).toBeGreaterThan(180 + PORTRAIT.width);
    });

    it('tracks the square: a lower square pushes the caption lower', () => {
      const squareHigher = resolveSummaryCaptionAnchor({ canvas: PORTRAIT, squareTopPx: 100 })!;
      const squareLower = resolveSummaryCaptionAnchor({ canvas: PORTRAIT, squareTopPx: 260 })!;
      // Caption sits a fixed gap below the square's edge, so lowering the square lowers the caption.
      expect(squareLower).toBeGreaterThan(squareHigher);
    });

    it('defers to the format preset on non-portrait canvases (no black band)', () => {
      expect(resolveSummaryCaptionAnchor({ canvas: { width: 1080, height: 1080 }, squareTopPx: 0 }))
        .toBeUndefined();
      expect(resolveSummaryCaptionAnchor({ canvas: { width: 1920, height: 1080 }, squareTopPx: 0 }))
        .toBeUndefined();
    });
  });

  it('rejects a narration longer than footage when no safe source bounds are supplied', () => {
    expect(() => allocateSummaryClipDurations(PLAN.beats[0]!.clips, 10)).toThrow('shorter than');
  });

  it('runs analysis, planning, narration, captions, music, and one timestamped compose handoff', async () => {
    await processVideoSummary(JOB);

    expect(analyzeActionWindows).toHaveBeenCalledWith(expect.stringContaining('source.mp4'), 1440);
    expect(extractEmbeddedSubtitleText).toHaveBeenCalledWith(expect.stringContaining('source.mp4'));
    expect(planVideoSummary).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'theme',
      theme: 'John gets saved',
      userContext: 'John is the pilot. He is separated from his team.',
      outputDurationSeconds: 60,
      subtitleText: expect.stringContaining('John is trapped'),
    }));
    expect(generateNarrationForScene).toHaveBeenCalledTimes(2);
    expect(generateNarrationForScene).toHaveBeenNthCalledWith(
      1,
      PLAN.beats[0]!.narration,
      JOB.voiceId,
      'gemini-tts-test',
      JOB.generationId,
      0,
      // Pace is asked for in the delivery prompt AND enforced by the stretch below — the prompt
      // now requests a brisk read, where it previously asked for a measured one.
      expect.stringMatching(/brisk, energetic pace/i),
      // Pitch-preserving stretch applied AFTER synthesis — the delivery prompt stays untouched.
      VIDEO_SUMMARY_NARRATION_TEMPO,
      // Preset voice ids resolve to `undefined` — generateNarrationForScene falls through to its
      // Google TTS path (voiceName = the raw voiceId, e.g. "Kore") instead of qwen.
      undefined,
    );
    expect(generateMusicBed).toHaveBeenCalledWith(
      PLAN.musicMood,
      'lyria-test',
      JOB.generationId,
      expect.stringMatching(/dramatic cinematic instrumental/i),
    );
    expect(uploadBufferToR2).toHaveBeenCalledWith(
      expect.any(Buffer),
      'generations/gen-summary-1.narration.wav',
      'audio/wav',
    );
    expect(mergeGenerationParams).toHaveBeenCalledWith(JOB.generationId, expect.objectContaining({
      format_id: 'video-explainer',
      summary_mode: 'theme',
      plot_understanding: {
        characters: PLAN.plotUnderstanding.characters,
        causal_summary: PLAN.plotUnderstanding.causalSummary,
        story_outline: PLAN.plotUnderstanding.storyOutline,
      },
      source_knowledge: {
        source: 'wikipedia',
        title: 'Example Show',
        url: 'https://en.wikipedia.org/wiki/Example_Show',
        confidence: 0.96,
      },
      structured: expect.objectContaining({
        videoClips: [
          expect.objectContaining({ trimStartSeconds: 10, trimEndSeconds: 14, outputDurationSeconds: 4 }),
          expect.objectContaining({ outputDurationSeconds: 2.6785714285714284 }),
          expect.objectContaining({ outputDurationSeconds: 3.5714285714285716 }),
        ],
      }),
    }));
    expect(ffmpegAdd).toHaveBeenCalledWith('generate', expect.objectContaining({
      op: 'summary_compose',
      inputR2Keys: [JOB.sourceR2Key],
      summaryCompose: expect.objectContaining({
        width: 1080,
        height: 1920,
        sourceFraming: 'fill',
        sourceR2Key: JOB.sourceR2Key,
        narrationR2Key: 'generations/gen-summary-1.narration.wav',
        musicR2Key: 'generations/gen-summary-1.music.wav',
        musicVolume: 0.18,
        captionStyle: expect.objectContaining({
          fontSize: 64,
          karaoke: false,
          outlineWidth: 3,
          shadowDepth: 1.5,
          backgroundBox: false,
          // Square lifted to top=280 → lower edge y=1360; caption 100px below in the black, at y=1460.
          yOffsetNorm: 1460 / 1920,
        }),
        portraitSquareTopPx: 280,
      }),
    }));
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it('renders "voiceA" through the qwen voice_clone path, never the preset speaker lookup', async () => {
    await processVideoSummary({ ...JOB, voiceId: 'voiceA' });

    expect(getUploadPresignedUrl).toHaveBeenCalledWith('reference-voices/voiceA-clipA.mp3');
    expect(generateNarrationForScene).toHaveBeenNthCalledWith(
      1,
      PLAN.beats[0]!.narration,
      'voiceA',
      'gemini-tts-test',
      JOB.generationId,
      0,
      expect.stringMatching(/brisk, energetic pace/i),
      VIDEO_SUMMARY_NARRATION_TEMPO,
      expect.objectContaining({
        mode: 'voice_clone',
        referenceAudioUrl: 'https://r2.example.com/episode.mp4',
        referenceText: expect.stringContaining('crystal horn rabbit'),
        language: 'English',
      }),
    );
  });

  it('fails and fully refunds when semantic planning fails', async () => {
    (planVideoSummary as jest.Mock).mockRejectedValueOnce(new Error('planner down'));
    await processVideoSummary(JOB);
    expect(markFailed).toHaveBeenCalledWith(JOB.generationId, 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith(
      JOB.userId,
      JOB.cost,
      `video-summary-failure-${JOB.generationId}`,
    );
    expect(ffmpegAdd).not.toHaveBeenCalled();
  });

  it('spends nothing and does not refund twice if the pending row was already reaped', async () => {
    (markProcessing as jest.Mock).mockResolvedValueOnce(false);
    await processVideoSummary(JOB);
    expect(getUploadPresignedUrl).not.toHaveBeenCalled();
    expect(planVideoSummary).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  describe('diegeticHighlightSeconds', () => {
    it('clamps the sum of raw clip durations to [3,6] seconds', () => {
      expect(diegeticHighlightSeconds([{ startSeconds: 0, endSeconds: 1, description: 'x' }])).toBe(3);
      expect(diegeticHighlightSeconds([{ startSeconds: 0, endSeconds: 4, description: 'x' }])).toBe(4);
      expect(diegeticHighlightSeconds([{ startSeconds: 0, endSeconds: 10, description: 'x' }])).toBe(6);
      expect(diegeticHighlightSeconds([
        { startSeconds: 0, endSeconds: 2, description: 'a' },
        { startSeconds: 10, endSeconds: 12.5, description: 'b' },
      ])).toBe(4.5);
    });
  });

  describe('"let the clip breathe" diegetic beat', () => {
    // Two clips in one diegetic beat, so the resulting diegeticWindows must carry one window per
    // underlying clip (not one per beat) — 2 + 2.5 = 4.5s, inside the [3,6] clamp.
    const DIEGETIC_CLIPS = [
      { startSeconds: 10, endSeconds: 12, description: 'clip a' },
      { startSeconds: 20, endSeconds: 22.5, description: 'clip b' },
    ];
    const diegeticPlan = () => ({
      ...PLAN,
      beats: [
        { narration: '', clips: DIEGETIC_CLIPS, audioMode: 'diegetic' as const },
        PLAN.beats[1],
      ],
    });

    it('skips TTS for a diegetic beat, uploads a silence stem sized to D_i, and threads per-clip diegeticWindows', async () => {
      mockConfig.videoSummaryDiegeticEnabled = true;
      (generateNarrationForScene as jest.Mock).mockReset().mockResolvedValueOnce({
        r2Key: 'generations/gen-summary-1.narration.1.wav',
        durationSeconds: 6.25,
      });
      (planVideoSummary as jest.Mock).mockResolvedValue(diegeticPlan());

      await processVideoSummary(JOB);

      // Only beat 1 (the narrated one) ever calls the TTS path.
      expect(generateNarrationForScene).toHaveBeenCalledTimes(1);
      expect(generateNarrationForScene).toHaveBeenCalledWith(
        PLAN.beats[1]!.narration,
        JOB.voiceId,
        'gemini-tts-test',
        JOB.generationId,
        1,
        expect.any(String),
        VIDEO_SUMMARY_NARRATION_TEMPO,
        undefined,
      );

      // Silence stem sized to D_i = clamp(2 + 2.5, 3, 6) = 4.5, uploaded under its own key.
      expect(silenceWav).toHaveBeenCalledWith(4.5);
      expect(uploadBufferToR2).toHaveBeenCalledWith(
        expect.any(Buffer),
        'generations/gen-summary-1.narration.0.silence.wav',
        'audio/wav',
      );

      const call = ffmpegAdd.mock.calls.find(([, payload]) => payload.op === 'summary_compose')!;
      expect(call[1].summaryCompose.diegeticWindows).toEqual([
        { startSec: 0, endSec: 2, sourceClipStartSec: 10, sourceClipEndSec: 12 },
        { startSec: 2, endSec: 4.5, sourceClipStartSec: 20, sourceClipEndSec: 22.5 },
      ]);
    });

    it('flag off: forces every beat to narrated even if the plan marks one diegetic (defense in depth)', async () => {
      mockConfig.videoSummaryDiegeticEnabled = false;
      (planVideoSummary as jest.Mock).mockResolvedValue(diegeticPlan());

      await processVideoSummary(JOB);

      expect(generateNarrationForScene).toHaveBeenCalledTimes(2);
      expect(silenceWav).not.toHaveBeenCalled();
      const call = ffmpegAdd.mock.calls.find(([, payload]) => payload.op === 'summary_compose')!;
      expect(call[1].summaryCompose.diegeticWindows).toBeUndefined();
    });

    it('no-audio-source fallback: forces narrated even with the flag on when the source has no audio stream', async () => {
      mockConfig.videoSummaryDiegeticEnabled = true;
      (probeHasAudioStream as jest.Mock).mockResolvedValue(false);
      (planVideoSummary as jest.Mock).mockResolvedValue(diegeticPlan());

      await processVideoSummary(JOB);

      expect(generateNarrationForScene).toHaveBeenCalledTimes(2);
      expect(silenceWav).not.toHaveBeenCalled();
      const call = ffmpegAdd.mock.calls.find(([, payload]) => payload.op === 'summary_compose')!;
      expect(call[1].summaryCompose.diegeticWindows).toBeUndefined();
    });
  });
});
