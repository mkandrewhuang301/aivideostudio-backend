jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn(), close: jest.fn() })),
  Worker: jest.fn().mockImplementation(() => ({ close: jest.fn(), on: jest.fn() })),
}));

jest.mock('../../config', () => ({
  config: {
    hiveScanRealFacePaths: true,
    nodeEnv: 'test',
  },
}));

jest.mock('../../services/providers/ReplicateProvider', () => ({
  generateStyledStill: jest.fn(),
}));

jest.mock('../../services/openaiScriptService', () => ({
  expandExplainerScript: jest.fn(),
  pickBestCandidateIndex: jest.fn(),
}));

jest.mock('../../services/sourceGroundingService', () => ({
  buildGroundingText: jest.fn(),
}));

jest.mock('../../services/geminiTtsService', () => ({
  generateNarrationForScene: jest.fn(),
}));

jest.mock('../../services/omniService', () => ({
  animateScene: jest.fn(),
}));

jest.mock('../../services/lyriaService', () => ({
  generateMusicBed: jest.fn(),
}));

jest.mock('../../services/whisperxService', () => ({
  ...jest.requireActual('../../services/whisperxService'),
  getWordTimings: jest.fn(),
}));

jest.mock('../../services/archivalService', () => ({
  getGenerationPresignedUrl: jest.fn(),
  uploadBufferToR2: jest.fn(),
}));

jest.mock('../../services/wavUtil', () => ({
  concatWavBuffers: jest.fn(),
}));

jest.mock('../../services/generationService', () => ({
  markProcessing: jest.fn(),
  markFailed: jest.fn(),
  markCompleted: jest.fn(),
  mergeGenerationParams: jest.fn(),
  classifyFailureReason: jest.fn(() => 'generic_error'),
}));

jest.mock('../../services/creditService', () => ({ refundCredits: jest.fn() }));

jest.mock('../../services/hiveService', () => ({ scanForCsam: jest.fn() }));

const ffmpegAdd = jest.fn();
jest.mock('../../queue/ffmpegWorker', () => ({
  ffmpegQueue: { add: ffmpegAdd },
}));

import { processExplainerGeneration } from '../../queue/explainerGenerationWorker';
import { generateStyledStill } from '../../services/providers/ReplicateProvider';
import {
  expandExplainerScript,
  pickBestCandidateIndex,
} from '../../services/openaiScriptService';
import { buildGroundingText } from '../../services/sourceGroundingService';
import { generateNarrationForScene } from '../../services/geminiTtsService';
import { animateScene } from '../../services/omniService';
import { generateMusicBed } from '../../services/lyriaService';
import { getWordTimings } from '../../services/whisperxService';
import {
  getGenerationPresignedUrl,
  uploadBufferToR2,
} from '../../services/archivalService';
import { concatWavBuffers } from '../../services/wavUtil';
import {
  markProcessing,
  markFailed,
  markCompleted,
  mergeGenerationParams,
  classifyFailureReason,
} from '../../services/generationService';
import { refundCredits } from '../../services/creditService';
import { scanForCsam } from '../../services/hiveService';
import type { ExplainerGenerationJob } from '../../queue/explainerGenerationQueue';

const JOB: ExplainerGenerationJob = {
  generationId: 'gen-explainer-1',
  userId: 'user-1',
  cost: 470,
  formatId: 'explainer',
  topic: 'How eclipses happen',
  styleId: 'pixel-art',
  voiceId: 'Kore',
  music: 'auto',
  sceneCount: 2,
  durationSeconds: 30,
  aspectRatio: '16:9',
  attachments: [{ r2Key: 'uploads/source.png', mimeType: 'image/png' }],
  sourceUrl: 'https://example.com/source',
};

const SCRIPT = {
  scenes: [
    {
      visual_prompt: 'pixel-art sun and moon with clean lower third',
      motion_prompt: 'gentle orbital movement',
      narration_line: 'First scene',
      text_zone: 'lower_third' as const,
      segment_type: 'dialogue' as const,
    },
    {
      visual_prompt: 'pixel-art eclipse shadow with clean lower third',
      motion_prompt: 'slow camera push',
      narration_line: 'Second scene',
      text_zone: 'lower_third' as const,
      segment_type: 'dialogue' as const,
    },
  ],
  music_mood: 'dramatic',
};

const GLOBAL_WORDS = [
  { text: 'First', startSeconds: 0, endSeconds: 0.4 },
  { text: 'scene', startSeconds: 0.4, endSeconds: 1 },
  { text: 'Second', startSeconds: 1, endSeconds: 2 },
  { text: 'scene', startSeconds: 2, endSeconds: 3 },
];

function signedUrlFor(key: string): string {
  return `https://r2.example.com/${encodeURIComponent(key)}`;
}

function candidateKey(sceneIndex: number, candidateIndex: number): string {
  return `generations/gen-explainer-1.scene${sceneIndex}.candidate${candidateIndex}.png`;
}

function candidateUrl(sceneIndex: number, candidateIndex: number): string {
  return signedUrlFor(candidateKey(sceneIndex, candidateIndex));
}

function resetHappyPath(): void {
  jest.resetAllMocks();
  ffmpegAdd.mockResolvedValue(undefined);
  (markProcessing as jest.Mock).mockResolvedValue(true);
  (markFailed as jest.Mock).mockResolvedValue(true);
  (classifyFailureReason as jest.Mock).mockReturnValue('generic_error');
  (refundCredits as jest.Mock).mockResolvedValue(undefined);
  (mergeGenerationParams as jest.Mock).mockResolvedValue(undefined);
  (buildGroundingText as jest.Mock).mockResolvedValue('grounded facts');
  (expandExplainerScript as jest.Mock).mockResolvedValue(SCRIPT);
  (generateNarrationForScene as jest.Mock)
    .mockResolvedValueOnce({ r2Key: 'generations/gen-explainer-1.narration.0.wav', durationSeconds: 1 })
    .mockResolvedValueOnce({ r2Key: 'generations/gen-explainer-1.narration.1.wav', durationSeconds: 2 });
  (generateStyledStill as jest.Mock).mockImplementation(
    (_prompt: string, _anchor: string, _model: string, outputKey: string) => (
      Promise.resolve(`generations/${outputKey}.png`)
    ),
  );
  (pickBestCandidateIndex as jest.Mock).mockResolvedValue(1);
  (scanForCsam as jest.Mock).mockResolvedValue({ flagged: false });
  (animateScene as jest.Mock)
    .mockResolvedValueOnce({ r2Key: 'generations/gen-explainer-1.scene0.mp4' })
    .mockResolvedValueOnce({ r2Key: 'generations/gen-explainer-1.scene1.mp4' });
  (concatWavBuffers as jest.Mock).mockReturnValue(Buffer.from('combined wav'));
  (uploadBufferToR2 as jest.Mock).mockResolvedValue(undefined);
  (getWordTimings as jest.Mock).mockResolvedValue(GLOBAL_WORDS);
  (generateMusicBed as jest.Mock).mockImplementation((mood: string) => Promise.resolve(
    mood === 'none' ? null : { r2Key: 'generations/gen-explainer-1.music.wav' },
  ));
  (getGenerationPresignedUrl as jest.Mock).mockImplementation((key: string) => Promise.resolve(signedUrlFor(key)));
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => Uint8Array.from([82, 73, 70, 70]).buffer,
  }) as jest.Mock;
}

beforeEach(resetHappyPath);

describe('processExplainerGeneration', () => {
  it('runs the full pipeline with N stills, one winning Omni clip per scene, structured params, and one compose job', async () => {
    await processExplainerGeneration(JOB);

    expect(generateStyledStill).toHaveBeenCalledTimes(6);
    expect(pickBestCandidateIndex).toHaveBeenCalledTimes(2);
    expect(pickBestCandidateIndex).toHaveBeenNthCalledWith(
      1,
      [candidateUrl(0, 0), candidateUrl(0, 1), candidateUrl(0, 2)],
      SCRIPT.scenes[0].visual_prompt,
      'lower_third',
    );
    expect(animateScene).toHaveBeenCalledTimes(2);
    expect(animateScene).toHaveBeenNthCalledWith(
      1,
      candidateUrl(0, 1),
      SCRIPT.scenes[0].motion_prompt,
      'google/gemini-omni-flash/image-to-video',
      '16:9',
      1,
      JOB.generationId,
      0,
    );
    expect(animateScene).toHaveBeenNthCalledWith(
      2,
      candidateUrl(1, 1),
      SCRIPT.scenes[1].motion_prompt,
      'google/gemini-omni-flash/image-to-video',
      '16:9',
      2,
      JOB.generationId,
      1,
    );

    expect(uploadBufferToR2).toHaveBeenCalledWith(
      expect.any(Buffer),
      'generations/gen-explainer-1.narration.wav',
      'audio/wav',
    );
    expect(mergeGenerationParams).toHaveBeenCalledWith(JOB.generationId, {
      format_id: 'explainer',
      structured: {
        audioStems: [{
          r2Key: 'generations/gen-explainer-1.narration.wav',
          sourceType: 'narration',
        }],
        captionCues: [
          {
            startSeconds: 0,
            endSeconds: 1,
            words: [
              { text: 'First', startSeconds: 0, endSeconds: 0.4 },
              { text: 'scene', startSeconds: 0.4, endSeconds: 1 },
            ],
          },
          {
            startSeconds: 1,
            endSeconds: 3,
            words: [
              { text: 'Second', startSeconds: 1, endSeconds: 2 },
              { text: 'scene', startSeconds: 2, endSeconds: 3 },
            ],
          },
        ],
      },
    });
    expect(ffmpegAdd).toHaveBeenCalledTimes(1);
    expect(ffmpegAdd).toHaveBeenCalledWith('generate', expect.objectContaining({
      generationId: JOB.generationId,
      op: 'explainer_compose',
      inputR2Keys: [
        'generations/gen-explainer-1.scene0.mp4',
        'generations/gen-explainer-1.scene1.mp4',
      ],
      explainerCompose: expect.objectContaining({
        clips: [
          { r2Key: 'generations/gen-explainer-1.scene0.mp4', durationSeconds: 1 },
          { r2Key: 'generations/gen-explainer-1.scene1.mp4', durationSeconds: 2 },
        ],
        narrationR2Key: 'generations/gen-explainer-1.narration.wav',
        musicR2Key: 'generations/gen-explainer-1.music.wav',
      }),
    }));
    expect(markFailed).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it('refunds the full cost when script generation throws', async () => {
    (expandExplainerScript as jest.Mock).mockRejectedValue(new Error('script failed'));

    await processExplainerGeneration(JOB);

    expect(markFailed).toHaveBeenCalledWith(JOB.generationId, 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith(
      JOB.userId,
      JOB.cost,
      `explainer-failure-${JOB.generationId}`,
    );
    expect(ffmpegAdd).not.toHaveBeenCalled();
  });

  it('refunds the full cost when TTS throws on a later scene', async () => {
    (generateNarrationForScene as jest.Mock).mockReset()
      .mockResolvedValueOnce({ r2Key: 'scene0.wav', durationSeconds: 1 })
      .mockRejectedValueOnce(new Error('TTS failed'));

    await processExplainerGeneration(JOB);

    expect(refundCredits).toHaveBeenCalledWith(
      JOB.userId,
      JOB.cost,
      `explainer-failure-${JOB.generationId}`,
    );
    expect(ffmpegAdd).not.toHaveBeenCalled();
  });

  it('treats both WhisperX and Lyria failures as hard full-refund failures', async () => {
    (getWordTimings as jest.Mock).mockRejectedValueOnce(new Error('WhisperX failed'));
    await processExplainerGeneration(JOB);
    expect(refundCredits).toHaveBeenCalledWith(JOB.userId, JOB.cost, `explainer-failure-${JOB.generationId}`);

    resetHappyPath();
    (generateMusicBed as jest.Mock).mockRejectedValueOnce(new Error('Lyria failed'));
    await processExplainerGeneration(JOB);
    expect(refundCredits).toHaveBeenCalledWith(JOB.userId, JOB.cost, `explainer-failure-${JOB.generationId}`);
    expect(ffmpegAdd).not.toHaveBeenCalled();
  });

  it('short-circuits music none and resolves auto to the script mood', async () => {
    await processExplainerGeneration({ ...JOB, music: 'none' });
    expect(generateMusicBed).toHaveBeenCalledWith('none', 'fal-ai/lyria2', JOB.generationId);
    expect(ffmpegAdd).toHaveBeenCalledWith('generate', expect.objectContaining({
      explainerCompose: expect.objectContaining({ musicR2Key: null }),
    }));

    resetHappyPath();
    await processExplainerGeneration({ ...JOB, music: 'auto' });
    expect(generateMusicBed).toHaveBeenCalledWith('dramatic', 'fal-ai/lyria2', JOB.generationId);
  });

  it('never marks the generation completed inside the orchestrator', async () => {
    await processExplainerGeneration(JOB);

    expect(markCompleted).not.toHaveBeenCalled();
  });

  it('falls back to candidate zero when the vision pick rejects without refunding', async () => {
    (pickBestCandidateIndex as jest.Mock).mockRejectedValue(new Error('vision unavailable'));

    await processExplainerGeneration(JOB);

    expect(animateScene).toHaveBeenNthCalledWith(
      1,
      candidateUrl(0, 0),
      expect.any(String),
      expect.any(String),
      '16:9',
      1,
      JOB.generationId,
      0,
    );
    expect(refundCredits).not.toHaveBeenCalled();
    expect(ffmpegAdd).toHaveBeenCalledTimes(1);
  });

  it('treats an Omni failure as a hard full-refund failure', async () => {
    (animateScene as jest.Mock).mockReset().mockRejectedValue(new Error('content policy'));

    await processExplainerGeneration(JOB);

    expect(refundCredits).toHaveBeenCalledWith(JOB.userId, JOB.cost, `explainer-failure-${JOB.generationId}`);
    expect(ffmpegAdd).not.toHaveBeenCalled();
  });

  it('does not output-scan Explainer stills and proceeds directly to animation', async () => {
    await processExplainerGeneration(JOB);
    expect(scanForCsam).not.toHaveBeenCalled();
    expect(animateScene).toHaveBeenCalledTimes(JOB.sceneCount);
    expect(ffmpegAdd).toHaveBeenCalledTimes(1);
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it('forwards the non-default per-request aspect ratio to every animate call', async () => {
    await processExplainerGeneration(JOB);

    expect(animateScene).toHaveBeenCalledTimes(JOB.sceneCount);
    for (const call of (animateScene as jest.Mock).mock.calls) {
      expect(call[3]).toBe(JOB.aspectRatio);
    }
  });

  it('resolves attachment URLs before script generation and also grounds the empty-input case', async () => {
    await processExplainerGeneration(JOB);
    expect(buildGroundingText).toHaveBeenCalledWith(
      [{ url: signedUrlFor('uploads/source.png'), mimeType: 'image/png' }],
      JOB.sourceUrl,
    );
    expect(expandExplainerScript).toHaveBeenCalledWith(expect.objectContaining({
      groundingText: 'grounded facts',
    }));
    expect((buildGroundingText as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (expandExplainerScript as jest.Mock).mock.invocationCallOrder[0],
    );

    resetHappyPath();
    await processExplainerGeneration({ ...JOB, attachments: [], sourceUrl: null });
    expect(buildGroundingText).toHaveBeenCalledWith([], null);
  });

  it('degrades a grounding rejection to absent context without refunding', async () => {
    (buildGroundingText as jest.Mock).mockRejectedValue(new Error('grounding unavailable'));

    await processExplainerGeneration(JOB);

    expect(expandExplainerScript).toHaveBeenCalledWith(expect.objectContaining({ groundingText: undefined }));
    expect(refundCredits).not.toHaveBeenCalled();
    expect(ffmpegAdd).toHaveBeenCalledTimes(1);
  });

  it('aborts without provider calls or another refund when the pending row was already reaped', async () => {
    (markProcessing as jest.Mock).mockResolvedValue(false);

    await processExplainerGeneration(JOB);

    expect(expandExplainerScript).not.toHaveBeenCalled();
    expect(generateNarrationForScene).not.toHaveBeenCalled();
    expect(generateStyledStill).not.toHaveBeenCalled();
    expect(animateScene).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it('calls markProcessing exactly once before every pipeline stage', async () => {
    await processExplainerGeneration(JOB);

    expect(markProcessing).toHaveBeenCalledTimes(1);
    expect(markProcessing).toHaveBeenCalledWith(JOB.generationId);
    const firstStageOrder = Math.min(
      (buildGroundingText as jest.Mock).mock.invocationCallOrder[0]!,
      (expandExplainerScript as jest.Mock).mock.invocationCallOrder[0]!,
      (generateNarrationForScene as jest.Mock).mock.invocationCallOrder[0]!,
      (generateStyledStill as jest.Mock).mock.invocationCallOrder[0]!,
      (animateScene as jest.Mock).mock.invocationCallOrder[0]!,
    );
    expect((markProcessing as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(firstStageOrder);
  });
});
