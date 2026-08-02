jest.mock('../../config', () => ({
  config: {
    aiMusicMaxDurationSeconds: 184,
    aiMusicClipModel: 'lyria-3-clip-preview',
    aiMusicProModel: 'lyria-3-pro-preview',
  },
}));
jest.mock('../../db/client', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    execute: jest.fn(),
    batch: jest.fn(),
  },
}));
jest.mock('../../storage/r2', () => ({
  r2: { send: jest.fn().mockResolvedValue({}) },
  R2_BUCKET: 'test',
}));
jest.mock('../../services/archivalService', () => ({ getUploadPresignedUrl: jest.fn() }));
jest.mock('../../queue/soundtrackGenerationQueue', () => ({
  soundtrackGenerationQueue: { add: jest.fn() },
}));
jest.mock('../../services/musicSuggestionService', () => ({
  suggestionsForProject: jest.fn(),
}));

import express, { NextFunction, Request } from 'express';
import request from 'supertest';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { db } from '../../db/client';
import { r2 } from '../../storage/r2';
import { aiMusicRouter } from '../../routes/aiMusic';
import {
  AI_MUSIC_AGE_TERMS_VERSION,
  attachSoundtrack,
  createSoundtrackGeneration,
  ensureAIMusicAgeTermsAccepted,
  fingerprintSnapshot,
  getSoundtrackQuote,
  quoteSoundtrack,
  type SoundtrackProjectSnapshot,
} from '../../services/soundtrackService';

const dbMock = db as unknown as {
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  execute: jest.Mock;
  batch: jest.Mock;
};
const r2Mock = r2 as unknown as { send: jest.Mock };

const app = express();
app.use(express.json());
app.use((req: Request, _res, next: NextFunction) => {
  req.user = { dbUserId: 'user-1', uid: 'firebase-user-1', email: 'user@example.com' };
  next();
});
app.use('/api', aiMusicRouter);

function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'set', 'values', 'select', 'returning', 'for']) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

const soundtrack = {
  id: 'soundtrack-1',
  project_id: 'source-project',
  user_id: 'user-1',
  status: 'completed',
  final_r2_key: 'soundtracks/soundtrack-1/final.m4a',
  display_name: 'Tailored soundtrack',
  project_duration_seconds: 12,
};

const attachedClip = {
  id: 'audio-10',
  project_id: 'target-project',
  r2_key: 'projects/target-project/audio/tenth.m4a',
  source_type: 'ai',
  source_soundtrack_id: soundtrack.id,
  sort_order: 9,
};

beforeEach(() => {
  jest.clearAllMocks();
  r2Mock.send.mockResolvedValue({});
  dbMock.insert.mockReturnValue(makeChain([]));
  dbMock.update.mockReturnValue(makeChain([]));
  dbMock.batch.mockImplementation(async (queries: PromiseLike<unknown>[]) => Promise.all(queries));
});

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

  it('tells a guest to show the attestation until the current version is accepted', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'project-1', title: 'Test' }]))
      .mockReturnValueOnce(makeChain([{
        id: 'clip-1',
        type: 'video',
        sortOrder: 0,
        r2Key: 'projects/test/clip.mp4',
        trimStart: 0,
        trimEnd: 5,
        originalDuration: 5,
      }]))
      .mockReturnValueOnce(makeChain([{ ageTermsVersion: null }]));

    await expect(getSoundtrackQuote('project-1', 'user-1')).resolves.toMatchObject({
      age_terms_required: true,
      age_terms_version: AI_MUSIC_AGE_TERMS_VERSION,
    });
  });
});

describe('AI Music age and Terms attestation', () => {
  it('blocks the real create path before the atomic credit query', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'project-1', title: 'Test' }]))
      .mockReturnValueOnce(makeChain([{
        id: 'clip-1',
        type: 'video',
        sortOrder: 0,
        r2Key: 'projects/test/clip.mp4',
        trimStart: 0,
        trimEnd: 5,
        originalDuration: 5,
      }]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ ageTermsVersion: null }]));

    await expect(createSoundtrackGeneration({
      projectId: 'project-1',
      userId: 'user-1',
      idempotencyKey: 'request-1',
      soundMode: 'instrumental',
    })).rejects.toMatchObject({ name: 'AIMusicAgeTermsRequiredError' });

    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('rejects a new creation without recording or deducting anything', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ ageTermsVersion: null }]));

    await expect(ensureAIMusicAgeTermsAccepted('user-1')).rejects.toMatchObject({
      name: 'AIMusicAgeTermsRequiredError',
      requiredVersion: AI_MUSIC_AGE_TERMS_VERSION,
    });
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('records the exact current version for a silent guest session', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ ageTermsVersion: null }]));

    await ensureAIMusicAgeTermsAccepted('user-1', AI_MUSIC_AGE_TERMS_VERSION);

    expect(dbMock.update).toHaveBeenCalledTimes(1);
    const setCall = (dbMock.update.mock.results[0]?.value as { set: jest.Mock }).set;
    expect(setCall).toHaveBeenCalledWith(expect.objectContaining({
      age_terms_version: AI_MUSIC_AGE_TERMS_VERSION,
      age_terms_accepted_at: expect.any(Date),
    }));
  });

  it('does not rewrite acceptance that is already current', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{
      ageTermsVersion: AI_MUSIC_AGE_TERMS_VERSION,
    }]));

    await ensureAIMusicAgeTermsAccepted('user-1');

    expect(dbMock.update).not.toHaveBeenCalled();
  });
});

describe('AI Music project attachment capacity', () => {
  it('maps the shared capacity error to the same 400 response as direct upload', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'target-project' }]))
      .mockReturnValueOnce(makeChain([soundtrack]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ id: 'target-project' }]))
      .mockReturnValueOnce(makeChain([]));
    dbMock.insert.mockReturnValueOnce(makeChain([]));
    dbMock.batch.mockResolvedValueOnce([[{ id: 'target-project' }], []]);

    const response = await request(app)
      .post(`/api/projects/target-project/audio/from-ai/${soundtrack.id}`);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Project already has the maximum of 10 audio clips',
    });
  });

  it('returns 404 for a cross-user target project without copying an object', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const response = await request(app)
      .post(`/api/projects/not-owned/audio/from-ai/${soundtrack.id}`);

    expect(response.status).toBe(404);
    expect(r2Mock.send).not.toHaveBeenCalled();
  });

  it('rejects an eleventh clip with the shared capacity error and deletes the copied object', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'target-project' }]))
      .mockReturnValueOnce(makeChain([soundtrack]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ id: 'target-project' }]))
      .mockReturnValueOnce(makeChain([]));
    // These keep the pre-20-02 implementation green far enough for the RED assertion to prove
    // it currently accepts an eleventh clip.
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 10 }] });
    dbMock.insert.mockReturnValueOnce(makeChain([{ ...attachedClip, id: 'audio-11', sort_order: 10 }]));
    dbMock.batch.mockResolvedValueOnce([[{ id: 'target-project' }], []]);

    await expect(attachSoundtrack('target-project', soundtrack.id, 'user-1'))
      .rejects.toThrow('Project already has the maximum of 10 audio clips');

    const deletes = r2Mock.send.mock.calls.filter((call) => call[0] instanceof DeleteObjectCommand);
    expect(deletes).toHaveLength(1);
  });

  it('allows exactly one concurrent AI Music attachment to claim the tenth slot', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'target-project' }]))
      .mockReturnValueOnce(makeChain([{ id: 'target-project' }]))
      .mockReturnValueOnce(makeChain([soundtrack]))
      .mockReturnValueOnce(makeChain([soundtrack]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ id: 'target-project' }]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ id: 'target-project' }]))
      .mockReturnValueOnce(makeChain([]));
    dbMock.execute
      .mockResolvedValueOnce({ rows: [{ next_order: 9 }] })
      .mockResolvedValueOnce({ rows: [{ next_order: 9 }] });
    dbMock.insert
      .mockReturnValueOnce(makeChain([attachedClip]))
      .mockReturnValueOnce(makeChain([{ ...attachedClip, id: 'audio-11' }]));
    dbMock.batch
      .mockResolvedValueOnce([[{ id: 'target-project' }], [attachedClip]])
      .mockResolvedValueOnce([[{ id: 'target-project' }], []]);

    const results = await Promise.allSettled([
      attachSoundtrack('target-project', soundtrack.id, 'user-1'),
      attachSoundtrack('target-project', soundtrack.id, 'user-1'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejection?.reason).toEqual(
      expect.objectContaining({ message: 'Project already has the maximum of 10 audio clips' }),
    );
    expect(dbMock.batch).toHaveBeenCalledTimes(2);
  });
});
