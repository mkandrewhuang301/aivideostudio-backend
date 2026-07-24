jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn(), close: jest.fn() })),
  Worker: jest.fn().mockImplementation(() => ({ close: jest.fn(), on: jest.fn() })),
}));

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
jest.mock('../../services/geminiTtsService', () => ({ generateNarrationForScene: jest.fn() }));
jest.mock('../../services/lyriaService', () => ({ generateMusicBed: jest.fn() }));
jest.mock('../../services/mediaProbe', () => ({ probeVideoMeta: jest.fn() }));
jest.mock('../../services/providers/ReplicateProvider', () => ({ transcribeWordTimings: jest.fn() }));
jest.mock('../../services/whisperxService', () => ({
  ...jest.requireActual('../../services/whisperxService'),
  getWordTimings: jest.fn(),
}));
jest.mock('../../services/wavUtil', () => ({ concatWavBuffers: jest.fn() }));
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
  processVideoSummary,
  resolveSummaryCaptionAnchor,
  VIDEO_SUMMARY_NARRATION_TEMPO,
} from '../../queue/videoSummaryWorker';
import { probeVideoMeta } from '../../services/mediaProbe';
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
import { concatWavBuffers } from '../../services/wavUtil';
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
      // Square top at y=180 → lower edge y=1260; caption 140px below → y=1400, in the black.
      const anchor = resolveSummaryCaptionAnchor({ canvas: PORTRAIT, squareTopPx: 180 })!;
      expect(anchor * PORTRAIT.height).toBeCloseTo(1400, 5);
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
      // qwen voice config: default preset speaker (Kore isn't a qwen speaker → Serena fallback).
      expect.objectContaining({ mode: 'custom_voice', speaker: 'Serena', language: 'English' }),
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
          // Square lifted to top=280 → lower edge y=1360; caption 140px below in the black, at y=1500.
          yOffsetNorm: 1500 / 1920,
        }),
        portraitSquareTopPx: 280,
      }),
    }));
    expect(refundCredits).not.toHaveBeenCalled();
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
});
