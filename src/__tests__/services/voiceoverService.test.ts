jest.mock('../../config', () => ({
  config: {},
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
jest.mock('../../services/archivalService', () => ({
  getUploadPresignedUrl: jest.fn(),
}));
jest.mock('../../middleware/promptModeration', () => ({
  isPromptFlagged: jest.fn(),
}));

import { db } from '../../db/client';
import { getUploadPresignedUrl } from '../../services/archivalService';
import { isPromptFlagged } from '../../middleware/promptModeration';
import {
  createVoiceoverGeneration,
  getVoiceover,
  getVoiceoverQuote,
  refundVoiceover,
  VoiceoverNotFoundError,
  VoiceoverValidationError,
  InsufficientVoiceoverCreditsError,
} from '../../services/voiceoverService';

const dbMock = db as unknown as {
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  execute: jest.Mock;
  batch: jest.Mock;
};
const presignedMock = getUploadPresignedUrl as unknown as jest.Mock;
const moderationMock = isPromptFlagged as unknown as jest.Mock;

function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'set', 'values', 'select', 'returning', 'for']) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';
const VOICEOVER_ID = 'voiceover-1';

beforeEach(() => {
  jest.clearAllMocks();
  moderationMock.mockResolvedValue(false);
  presignedMock.mockImplementation(() => Promise.resolve('https://signed.example/audio.wav'));
  dbMock.insert.mockReturnValue(makeChain([]));
  dbMock.batch.mockImplementation(async (queries: PromiseLike<unknown>[]) => Promise.all(queries));
});

describe('getVoiceoverQuote', () => {
  it('returns a quote for a known voice and valid script', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: PROJECT_ID }]));

    const quote = await getVoiceoverQuote(PROJECT_ID, USER_ID, 'kore', 'Hello world.');

    expect(quote).toMatchObject({
      voice_id: 'kore',
      script_preview: 'Hello world.',
      cost_credits: expect.any(Number),
      estimated_provider_cents: expect.any(Number),
      pricing_version: expect.any(String),
    });
  });

  it('returns null when the project is not owned by the user', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const quote = await getVoiceoverQuote(PROJECT_ID, USER_ID, 'kore', 'Hello.');
    expect(quote).toBeNull();
  });

  it('throws for an unknown voice id', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: PROJECT_ID }]));

    await expect(getVoiceoverQuote(PROJECT_ID, USER_ID, 'not-a-voice', 'Hello.'))
      .rejects.toThrow(VoiceoverValidationError);
  });

  it('throws for an empty script', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: PROJECT_ID }]));

    await expect(getVoiceoverQuote(PROJECT_ID, USER_ID, 'kore', ''))
      .rejects.toThrow(VoiceoverValidationError);
  });

  it('throws for a script over 5000 characters', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: PROJECT_ID }]));

    await expect(getVoiceoverQuote(PROJECT_ID, USER_ID, 'kore', 'a'.repeat(5001)))
      .rejects.toThrow(VoiceoverValidationError);
  });
});

describe('createVoiceoverGeneration', () => {
  it('deducts credits atomically and inserts a pending row', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: PROJECT_ID }]))
      .mockReturnValueOnce(makeChain([]));
    const row = {
      id: VOICEOVER_ID,
      user_id: USER_ID,
      project_id: PROJECT_ID,
      status: 'pending',
      voice_id: 'kore',
      script: 'Hello world.',
      cost_credits: 1,
    };
    dbMock.execute.mockResolvedValueOnce({ rows: [row] });

    const created = await createVoiceoverGeneration({
      projectId: PROJECT_ID,
      userId: USER_ID,
      idempotencyKey: 'key-1',
      voiceId: 'kore',
      script: 'Hello world.',
    });

    expect(created.created).toBe(true);
    expect(created.row).toMatchObject(row);

    const executeCall = dbMock.execute.mock.calls[0][0];
    const rawSql = JSON.stringify(executeCall);
    expect(rawSql).toContain('credits_balance >=');
    expect(rawSql).toContain('generation_deduct');
    expect(rawSql).toContain('voiceover:');
  });

  it('blocks moderated scripts before charging', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: PROJECT_ID }]));
    moderationMock.mockResolvedValueOnce(true);

    await expect(createVoiceoverGeneration({
      projectId: PROJECT_ID,
      userId: USER_ID,
      idempotencyKey: 'key-1',
      voiceId: 'kore',
      script: 'Blocked content',
    })).rejects.toThrow(VoiceoverValidationError);

    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('throws InsufficientVoiceoverCreditsError when the conditional deduction returns no row', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: PROJECT_ID }]))
      .mockReturnValueOnce(makeChain([]));
    dbMock.execute.mockResolvedValueOnce({ rows: [] });

    await expect(createVoiceoverGeneration({
      projectId: PROJECT_ID,
      userId: USER_ID,
      idempotencyKey: 'key-1',
      voiceId: 'kore',
      script: 'Hello world.',
    })).rejects.toThrow(InsufficientVoiceoverCreditsError);
  });

  it('returns the winner row when an idempotency key collides', async () => {
    const winner = {
      id: VOICEOVER_ID,
      user_id: USER_ID,
      project_id: PROJECT_ID,
      status: 'pending',
      voice_id: 'kore',
      script: 'Hello world.',
      cost_credits: 1,
    };
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: PROJECT_ID }]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([winner]));
    const conflictError = Object.assign(new Error('unique violation'), { code: '23505' });
    dbMock.execute.mockRejectedValueOnce(conflictError);

    const created = await createVoiceoverGeneration({
      projectId: PROJECT_ID,
      userId: USER_ID,
      idempotencyKey: 'key-1',
      voiceId: 'kore',
      script: 'Hello world.',
    });

    expect(created.created).toBe(false);
    expect(created.row).toMatchObject(winner);
  });

  it('refunds credits exactly once with a deterministic reference', async () => {
    dbMock.execute.mockResolvedValueOnce({ rows: [{ user_id: USER_ID, cost_credits: 1 }] });

    const refunded = await refundVoiceover(VOICEOVER_ID, 'queue_unavailable', 'Could not start');

    expect(refunded).toBe(true);
    const executeCall = dbMock.execute.mock.calls[0][0];
    const rawSql = JSON.stringify(executeCall);
    expect(rawSql).toContain('refunded');
    expect(rawSql).toContain('generation_refund');
    expect(rawSql).toContain('voiceover-refund:');
  });

  it('returns false when refunding a row that is not refundable', async () => {
    dbMock.execute.mockResolvedValueOnce({ rows: [] });

    const refunded = await refundVoiceover(VOICEOVER_ID, 'queue_unavailable', 'Could not start');
    expect(refunded).toBe(false);
  });
});

describe('getVoiceover', () => {
  it('returns a safe projection with a signed URL for completed rows', async () => {
    const row = {
      id: VOICEOVER_ID,
      user_id: USER_ID,
      project_id: PROJECT_ID,
      status: 'succeeded',
      voice_id: 'kore',
      script: 'Hello world.',
      provider: 'google',
      model: 'chirp3-hd',
      final_r2_key: 'voiceovers/v1/final.wav',
      cost_credits: 1,
      created_at: new Date(),
    };
    dbMock.select.mockReturnValueOnce(makeChain([row]));

    const result = await getVoiceover(VOICEOVER_ID, PROJECT_ID, USER_ID);

    expect(result).toMatchObject({
      voiceover_id: VOICEOVER_ID,
      status: 'succeeded',
      audio_url: expect.stringContaining('https://signed.example/'),
    });
    expect(result?.audio_url).not.toContain('voiceovers/v1/final.wav');
    expect(JSON.stringify(result)).not.toContain('provider');
    expect(JSON.stringify(result)).not.toContain('model');
    expect(JSON.stringify(result)).not.toContain('final_r2_key');
  });

  it('returns null for a cross-user or missing voiceover', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const result = await getVoiceover(VOICEOVER_ID, PROJECT_ID, USER_ID);
    expect(result).toBeNull();
  });
});
