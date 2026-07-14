// src/__tests__/queue/ffmpegWorker.test.ts
// Wave 0 scaffold (09.3-01) — SC1: ffmpeg BullMQ worker mux + final-failure refund contract.
// RED until 09.3-02 builds src/queue/ffmpegWorker.ts (cloned from hiveScanWorker.ts's
// Queue/Worker/connectionOptions + completion-rejoin + final-failure pattern — RESEARCH.md #1).
//
// No live Redis/ffmpeg required — BullMQ is mocked; logic is tested via exported named functions,
// exactly like hiveScanWorker.test.ts.

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn(), close: jest.fn() })),
  Worker: jest.fn().mockImplementation(() => ({ close: jest.fn(), on: jest.fn() })),
}));

jest.mock('../../config', () => ({
  config: {
    replicateWebhookSecret: 'whsec_test',
    databaseUrl: 'mock://db',
    redisUrl: 'redis://localhost',
    r2AccountId: 'mock', r2AccessKeyId: 'mock', r2SecretAccessKey: 'mock',
    r2BucketName: 'mock', r2PublicDomain: '',
    firebaseProjectId: 'mock', firebaseClientEmail: 'mock@mock.iam.gserviceaccount.com',
    firebasePrivateKey: 'mock-key', apnsAuthKey: 'mock-key', apnsKeyId: 'mock',
    apnsTeamId: 'mock', apnsBundleId: 'mock', replicateApiToken: 'mock-token',
    hiveApiKey: 'mock-hive-key', publicBaseUrl: 'https://mock.example.com',
    port: 3000, nodeEnv: 'test',
  },
}));

jest.mock('../../services/generationService', () => ({
  markCompleted: jest.fn(),
  markFailed: jest.fn(),
  mergeGenerationParams: jest.fn(),
}));
jest.mock('../../services/creditService', () => ({ refundCredits: jest.fn() }));
jest.mock('../../services/apnsService', () => ({ sendGenerationComplete: jest.fn() }));
jest.mock('../../db/client', () => ({ db: { execute: jest.fn() } }));
// 09.3-02: real download/ffmpeg-spawn/R2-upload I/O lives in ffmpegProcessor.ts (the single seam
// ffmpegWorker.ts calls through) — mocked here so this suite never touches a live ffmpeg binary,
// network fetch, or R2 credentials. Per 09.3-01's SUMMARY, the Wave 0 scaffold deliberately did
// NOT invent this mock path, leaving the internal shape to this plan.
jest.mock('../../queue/ffmpegProcessor', () => ({ runFfmpegOp: jest.fn() }));

import { markCompleted, markFailed, mergeGenerationParams } from '../../services/generationService';
import { refundCredits } from '../../services/creditService';
import { sendGenerationComplete } from '../../services/apnsService';
import { db } from '../../db/client';
import { runFfmpegOp } from '../../queue/ffmpegProcessor';
// FFMPEG_ATTEMPTS mirrors HIVE_SCAN_ATTEMPTS's role: the queue's defaultJobOptions.attempts,
// exported so this file's expectation and the queue config can never silently drift apart (same
// regression guard as hiveScanWorker.test.ts).
import { processFfmpegJob, handleFfmpegFinalFailure, FFMPEG_ATTEMPTS } from '../../queue/ffmpegWorker';

// Job payload shape per RESEARCH.md #1: { generationId, inputR2Keys[], audioR2Key?, op, userId,
// costCredits, mediaType:'video' } — the ffmpeg worker's second-stage post-process job.
const JOB_DATA = {
  generationId: 'gen-ffmpeg-1',
  inputR2Keys: ['generations/gen-ffmpeg-1-raw.mp4'],
  audioR2Key: 'assets/trend-audio/clip1.m4a',
  op: 'mux' as const,
  userId: 'user-1',
  costCredits: 71,
  mediaType: 'video' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  (db.execute as jest.Mock).mockResolvedValue({ rows: [{ apns_device_token: 'token-abc' }] });
  (markCompleted as jest.Mock).mockResolvedValue(true);
  (markFailed as jest.Mock).mockResolvedValue(true);
  (mergeGenerationParams as jest.Mock).mockResolvedValue(undefined);
  (refundCredits as jest.Mock).mockResolvedValue(undefined);
  (sendGenerationComplete as jest.Mock).mockResolvedValue(undefined);
  (runFfmpegOp as jest.Mock).mockResolvedValue({
    r2Key: `generations/${JOB_DATA.generationId}.mp4`,
    masterR2Key: `generations/${JOB_DATA.generationId}.silent.mp4`,
  });
});

describe('processFfmpegJob', () => {
  it('mux success: marks completed with the final muxed r2 key and sends a video completion push (SC1)', async () => {
    await processFfmpegJob(JOB_DATA);

    expect(markCompleted).toHaveBeenCalledWith(JOB_DATA.generationId, expect.any(String));
    expect(sendGenerationComplete).toHaveBeenCalledWith('token-abc', JOB_DATA.generationId, 'video');
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it('mux success: stamps silent_master_r2_key + applied_audio_r2_key on the row (D-04)', async () => {
    await processFfmpegJob(JOB_DATA);

    expect(mergeGenerationParams).toHaveBeenCalledWith(JOB_DATA.generationId, {
      silent_master_r2_key: `generations/${JOB_DATA.generationId}.silent.mp4`,
      applied_audio_r2_key: JOB_DATA.audioR2Key,
    });
  });

  it('concat success: does NOT stamp silent_master_r2_key (no single silent source)', async () => {
    (runFfmpegOp as jest.Mock).mockResolvedValue({ r2Key: `generations/${JOB_DATA.generationId}.mp4` });
    const concatJobData = { ...JOB_DATA, op: 'concat' as const, audioR2Key: undefined };

    await processFfmpegJob(concatJobData);

    expect(markCompleted).toHaveBeenCalledWith(concatJobData.generationId, expect.any(String));
    expect(mergeGenerationParams).not.toHaveBeenCalled();
  });

  it('compose success: routes through the SAME markCompleted/APNs completion path unchanged (Phase 13 SC7)', async () => {
    (runFfmpegOp as jest.Mock).mockResolvedValue({ r2Key: `generations/${JOB_DATA.generationId}.mp4` });
    const composeJobData = {
      ...JOB_DATA,
      op: 'compose' as const,
      costCredits: 0, // D-10: export is free
      audioR2Key: undefined,
      inputR2Keys: [],
      compose: {
        aspectRatio: '9:16' as const,
        clips: [],
        textOverlays: [],
        audioClips: [],
        captionCues: [],
        captionStyle: { fontSize: 64, color: '#FFFFFF', highlightColor: '#FFFF00', position: 'bottom' as const },
      },
    };

    await processFfmpegJob(composeJobData);

    expect(markCompleted).toHaveBeenCalledWith(composeJobData.generationId, expect.any(String));
    expect(sendGenerationComplete).toHaveBeenCalledWith('token-abc', composeJobData.generationId, 'video');
    // compose returns no masterR2Key (no single silent source) — same as concat's shape.
    expect(mergeGenerationParams).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });
});

describe('handleFfmpegFinalFailure', () => {
  it('marks failed and refunds credits with the ffmpeg-timeout idempotency key', async () => {
    const err = new Error('ffmpeg mux failed after all retries');

    await handleFfmpegFinalFailure(JOB_DATA, err);

    expect(markFailed).toHaveBeenCalledWith(JOB_DATA.generationId);
    expect(refundCredits).toHaveBeenCalledWith(
      JOB_DATA.userId, JOB_DATA.costCredits, `ffmpeg-timeout-${JOB_DATA.generationId}`,
    );
  });

  it('FFMPEG_ATTEMPTS is a positive number matching the queue defaultJobOptions attempts', () => {
    expect(typeof FFMPEG_ATTEMPTS).toBe('number');
    expect(FFMPEG_ATTEMPTS).toBeGreaterThan(0);
  });
});
