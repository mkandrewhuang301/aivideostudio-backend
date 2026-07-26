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

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { db } from '../../db/client';
import { r2 } from '../../storage/r2';
import {
  attachSoundtrack,
  fingerprintSnapshot,
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

function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'set', 'values', 'returning']) {
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
});

describe('AI Music project attachment capacity', () => {
  it('rejects an eleventh clip with the shared capacity error and deletes the copied object', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'target-project' }]))
      .mockReturnValueOnce(makeChain([soundtrack]))
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
