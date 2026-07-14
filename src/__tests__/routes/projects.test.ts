// src/__tests__/routes/projects.test.ts
// Route + service tests for Phase 13's project CRUD API (13-03-PLAN.md).
// Covers: CRUD, PATCH /:id validation/IDOR, import-by-copy source-ownership (T-13-08),
// smart-unpack (D-15/D-16), and IDOR guards across every route (T-13-07).

jest.mock('../../storage/r2', () => ({
  r2: { send: jest.fn().mockResolvedValue({}) },
  R2_BUCKET: 'test-bucket',
}));

jest.mock('../../services/archivalService', () => ({
  getUploadPresignedUrl: jest.fn().mockResolvedValue('https://r2.example.com/presigned-clip-url'),
}));

// db/client must be mocked — neon() throws at module eval with a non-postgres URL
jest.mock('../../db/client', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    execute: jest.fn(),
  },
}));

const mockFfmpegQueueAdd = jest.fn();
jest.mock('../../queue/ffmpegWorker', () => ({
  ffmpegQueue: { add: mockFfmpegQueueAdd },
}));

const mockCreateGeneration = jest.fn();
jest.mock('../../services/generationService', () => ({
  createGeneration: (...args: unknown[]) => mockCreateGeneration(...args),
}));

const mockTranscribeToWordCues = jest.fn();
jest.mock('../../services/captionTranscriptionService', () => {
  class TranscriptionError extends Error {}
  return {
    transcribeToWordCues: (...args: unknown[]) => mockTranscribeToWordCues(...args),
    TranscriptionError,
  };
});

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { CopyObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { projectsRouter } from '../../routes/projects';
import { smartUnpackOnImport } from '../../services/projectService';
import { TranscriptionError } from '../../services/captionTranscriptionService';
import { r2 } from '../../storage/r2';
import { db } from '../../db/client';

const r2Mock = r2 as unknown as { send: jest.Mock };
const dbMock = db as unknown as {
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  execute: jest.Mock;
};

// A thenable drizzle-style chain builder: every chaining method returns the SAME chain object
// (which is itself thenable), so `await db.select().from(x).where(y)` resolves to `result`
// regardless of how many/which chain methods the calling code happens to invoke.
function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'where', 'orderBy', 'limit', 'set', 'values', 'returning'];
  for (const m of methods) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) =>
    Promise.resolve(result).then(resolve, reject);
  return chain as unknown as {
    from: jest.Mock;
    where: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    set: jest.Mock;
    values: jest.Mock;
    returning: jest.Mock;
  };
}

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.user = { dbUserId: 'test-db-user-id', uid: 'fb-uid', email: 't@test.com' };
  next();
});
app.use('/api/projects', projectsRouter);

const unauthApp = express();
unauthApp.use(express.json());
unauthApp.use('/api/projects', projectsRouter);

const NOW = new Date('2026-07-13T00:00:00.000Z');

function baseProjectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    user_id: 'test-db-user-id',
    title: null,
    aspect_ratio: '9:16',
    thumbnail_r2_key: null,
    caption_style: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  r2Mock.send.mockResolvedValue({});
});

// ─── POST /api/projects ────────────────────────────────────────────────────────

describe('POST /api/projects', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(unauthApp).post('/api/projects').send({});
    expect(res.status).toBe(401);
  });

  it('creates a project and returns 201 with the project row', async () => {
    dbMock.insert.mockReturnValueOnce(makeChain([baseProjectRow({ id: 'new-proj' })]));

    const res = await request(app).post('/api/projects').send({ title: 'My Video' });

    expect(res.status).toBe(201);
    expect(res.body.project.id).toBe('new-proj');
  });

  it('rejects an invalid aspect_ratio with 400 and never touches the db', async () => {
    const res = await request(app).post('/api/projects').send({ aspectRatio: '21:9' });

    expect(res.status).toBe(400);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

// ─── GET /api/projects ──────────────────────────────────────────────────────────

describe('GET /api/projects', () => {
  it('returns items + nextCursor shape (newest-first list)', async () => {
    dbMock.select.mockReturnValueOnce(
      makeChain([
        baseProjectRow({ id: 'p1', created_at: new Date('2026-07-10') }),
        baseProjectRow({ id: 'p2', created_at: new Date('2026-07-09') }),
      ]),
    );

    const res = await request(app).get('/api/projects?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].id).toBe('p1');
    // full page (length === limit) => nextCursor present
    expect(res.body.nextCursor).toBe('2026-07-09T00:00:00.000Z__p2');
    // thumbnail_r2_key never leaks raw — replaced by thumbnail_url
    expect(res.body.items[0].thumbnail_r2_key).toBeUndefined();
  });

  it('returns null nextCursor when fewer than limit items returned', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([baseProjectRow({ id: 'only-one' })]));

    const res = await request(app).get('/api/projects?limit=20');

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
  });
});

// ─── GET /api/projects/:id ──────────────────────────────────────────────────────

describe('GET /api/projects/:id', () => {
  it('returns 404 for a project owned by another user (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([])); // ownership-scoped project lookup finds nothing

    const res = await request(app).get('/api/projects/not-mine');

    expect(res.status).toBe(404);
  });

  it('returns 200 with presigned (never raw r2_key) urls for every clip/audio when owned', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1' })])) // project row
      .mockReturnValueOnce(
        makeChain([
          { id: 'clip-1', project_id: 'proj-1', sort_order: 0, r2_key: 'projects/proj-1/clips/a.mp4', media_type: 'video', source_type: 'upload', original_duration_seconds: null, trim_start_seconds: 0, trim_end_seconds: null, created_at: NOW },
        ]),
      ) // clips
      .mockReturnValueOnce(makeChain([])) // text overlays
      .mockReturnValueOnce(
        makeChain([
          { id: 'audio-1', project_id: 'proj-1', r2_key: 'projects/proj-1/audio/a.mp3', source_type: 'upload', start_offset_seconds: 0, trim_start_seconds: 0, trim_end_seconds: null, sort_order: 0, created_at: NOW },
        ]),
      ) // audio clips
      .mockReturnValueOnce(makeChain([])); // caption cues (empty => no word query fired)

    const res = await request(app).get('/api/projects/proj-1');

    expect(res.status).toBe(200);
    expect(res.body.project.clips).toHaveLength(1);
    expect(res.body.project.clips[0].url).toBe('https://r2.example.com/presigned-clip-url');
    expect(res.body.project.clips[0].r2_key).toBeUndefined();
    expect(res.body.project.audio_clips[0].url).toBe('https://r2.example.com/presigned-clip-url');
    expect(res.body.project.audio_clips[0].r2_key).toBeUndefined();
  });
});

// ─── PATCH /api/projects/:id ────────────────────────────────────────────────────

describe('PATCH /api/projects/:id', () => {
  it('updates title only, leaving aspect_ratio/caption_style out of the SET payload', async () => {
    const setFn = jest.fn().mockReturnValue(makeChain([baseProjectRow({ title: 'Renamed' })]));
    dbMock.update.mockReturnValueOnce({ set: setFn });

    const res = await request(app).patch('/api/projects/proj-1').send({ title: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.project.title).toBe('Renamed');
    const setArg = setFn.mock.calls[0][0];
    expect(setArg).toHaveProperty('title', 'Renamed');
    expect(setArg).not.toHaveProperty('aspect_ratio');
    expect(setArg).not.toHaveProperty('caption_style');
  });

  it('updates aspect_ratio to a valid value with 200', async () => {
    const setFn = jest.fn().mockReturnValue(makeChain([baseProjectRow({ aspect_ratio: '1:1' })]));
    dbMock.update.mockReturnValueOnce({ set: setFn });

    const res = await request(app).patch('/api/projects/proj-1').send({ aspect_ratio: '1:1' });

    expect(res.status).toBe(200);
    expect(res.body.project.aspect_ratio).toBe('1:1');
  });

  it('rejects an invalid aspect_ratio (21:9) with 400 and never touches the db', async () => {
    const res = await request(app).patch('/api/projects/proj-1').send({ aspect_ratio: '21:9' });

    expect(res.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('updates caption_style with 200', async () => {
    const style = { fontSize: 32, color: '#fff', highlightColor: '#0f0', position: 'bottom' };
    const setFn = jest.fn().mockReturnValue(makeChain([baseProjectRow({ caption_style: style })]));
    dbMock.update.mockReturnValueOnce({ set: setFn });

    const res = await request(app).patch('/api/projects/proj-1').send({ caption_style: style });

    expect(res.status).toBe(200);
    expect(res.body.project.caption_style).toEqual(style);
  });

  it('rejects an invalid caption_style.position with 400', async () => {
    const res = await request(app)
      .patch('/api/projects/proj-1')
      .send({ caption_style: { fontSize: 32, color: '#fff', highlightColor: '#0f0', position: 'left' } });

    expect(res.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('returns 404 when the project belongs to another user (IDOR cross-user rejection)', async () => {
    const setFn = jest.fn().mockReturnValue(makeChain([])); // WHERE user_id=... matched 0 rows
    dbMock.update.mockReturnValueOnce({ set: setFn });

    const res = await request(app).patch('/api/projects/not-mine').send({ title: 'Hijacked' });

    expect(res.status).toBe(404);
  });
});

// ─── DELETE /api/projects/:id ───────────────────────────────────────────────────

describe('DELETE /api/projects/:id', () => {
  it('returns 404 when not owned', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([])); // ownership lookup empty

    const res = await request(app).delete('/api/projects/not-mine');

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/projects/:id/clips ───────────────────────────────────────────────

describe('POST /api/projects/:id/clips', () => {
  it("rejects importing ANOTHER user's generation (source-ownership IDOR) — no CopyObjectCommand sent", async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{ count: 0 }])) // clip count
      .mockReturnValueOnce(makeChain([])); // generation ownership-scoped lookup: another user's row → empty

    const res = await request(app)
      .post('/api/projects/proj-1/clips')
      .send({ source_type: 'generation', generation_id: 'someone-elses-gen' });

    expect(res.status).toBe(404);
    const copyCalls = r2Mock.send.mock.calls.filter((c) => c[0] instanceof CopyObjectCommand);
    expect(copyCalls).toHaveLength(0);
  });

  it('happy path: imports a generation via CopyObjectCommand into projects/{id}/clips/ and inserts a clip', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{ count: 0 }])) // clip count
      .mockReturnValueOnce(
        makeChain([
          { id: 'gen-1', r2_key: 'generations/gen-1.mp4', status: 'completed', media_type: 'video', params: null, user_id: 'test-db-user-id' },
        ]),
      ) // route's own generation lookup
      .mockReturnValueOnce(
        makeChain([{ r2_key: 'generations/gen-1.mp4', status: 'completed' }]),
      ); // importClipByCopy's internal ownership-scoped lookup
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 0 }] });
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        { id: 'clip-1', project_id: 'proj-1', sort_order: 0, r2_key: 'projects/proj-1/clips/new-uuid.mp4', media_type: 'video', source_type: 'generation', original_duration_seconds: null, created_at: NOW },
      ]),
    );

    const res = await request(app)
      .post('/api/projects/proj-1/clips')
      .send({ source_type: 'generation', generation_id: 'gen-1' });

    expect(res.status).toBe(201);
    expect(res.body.clip.id).toBe('clip-1');
    const copyCall = r2Mock.send.mock.calls.find((c) => c[0] instanceof CopyObjectCommand);
    expect(copyCall).toBeDefined();
    expect(copyCall![0].input.Key).toMatch(/^projects\/proj-1\/clips\//);
    expect(copyCall![0].input.CopySource).toBe('test-bucket/generations/gen-1.mp4');
  });

  it('rejects with 400 when the project already holds the maximum clip count', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{ count: 50 }])); // at cap

    const res = await request(app)
      .post('/api/projects/proj-1/clips')
      .send({ source_type: 'generation', generation_id: 'gen-1' });

    expect(res.status).toBe(400);
  });

  it('upload path: writes a fresh file directly to projects/{id}/clips/ via PutObjectCommand', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{ count: 0 }])); // clip count
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 0 }] });
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        { id: 'clip-2', project_id: 'proj-1', sort_order: 0, r2_key: 'projects/proj-1/clips/upload-uuid.jpg', media_type: 'image', source_type: 'upload', original_duration_seconds: null, created_at: NOW },
      ]),
    );

    const res = await request(app)
      .post('/api/projects/proj-1/clips')
      .attach('file', Buffer.from('fake-jpg'), { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    const putCall = r2Mock.send.mock.calls.find((c) => c[0] instanceof PutObjectCommand);
    expect(putCall).toBeDefined();
    expect(putCall![0].input.Key).toMatch(/^projects\/proj-1\/clips\//);
    const copyCalls = r2Mock.send.mock.calls.filter((c) => c[0] instanceof CopyObjectCommand);
    expect(copyCalls).toHaveLength(0);
  });
});

// ─── PATCH /api/projects/:id/clips/:clipId ─────────────────────────────────────

describe('PATCH /api/projects/:id/clips/:clipId', () => {
  it('trims a clip and returns 200', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // owned project
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'clip-1', project_id: 'proj-1', sort_order: 0, trim_start_seconds: 2, trim_end_seconds: 8 }]),
    );

    const res = await request(app)
      .patch('/api/projects/proj-1/clips/clip-1')
      .send({ trim_start_seconds: 2, trim_end_seconds: 8 });

    expect(res.status).toBe(200);
    expect(res.body.clip.trim_start_seconds).toBe(2);
  });

  it('returns 404 when the project is not owned by the requester', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([])); // ownership lookup empty

    const res = await request(app).patch('/api/projects/not-mine/clips/clip-1').send({ sort_order: 1 });

    expect(res.status).toBe(404);
  });
});

// ─── DELETE /api/projects/:id/clips/:clipId ────────────────────────────────────

describe('DELETE /api/projects/:id/clips/:clipId', () => {
  it('returns 204 and deletes the R2 object', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{ r2_key: 'projects/proj-1/clips/c1.mp4' }])); // clip lookup
    dbMock.delete.mockReturnValueOnce(makeChain(undefined));

    const res = await request(app).delete('/api/projects/proj-1/clips/clip-1');

    expect(res.status).toBe(204);
    const deleteCall = r2Mock.send.mock.calls.find((c) => c[0] instanceof DeleteObjectCommand);
    expect(deleteCall).toBeDefined();
    expect(deleteCall![0].input.Key).toBe('projects/proj-1/clips/c1.mp4');
  });
});

// ─── POST /api/projects/:id/clips/:clipId/split (T-13-19 Task G1) ─────────────

describe('POST /api/projects/:id/clips/:clipId/split', () => {
  it('happy path: CopyObjects the source r2_key, inserts the new clip, and shrinks the original trim_end', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // route ownership check
      .mockReturnValueOnce(makeChain([{ count: 1 }])) // cap check
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // splitClip's isProjectOwned
      .mockReturnValueOnce(makeChain([baseClipRow({ trim_start_seconds: 0, trim_end_seconds: 10 })])); // clip lookup
    dbMock.execute.mockResolvedValueOnce({ rows: [] }); // resequence UPDATE
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        {
          id: 'clip-2',
          project_id: 'proj-1',
          sort_order: 1,
          r2_key: 'projects/proj-1/clips/new-uuid.mp4',
          media_type: 'video',
          source_type: 'upload',
          original_duration_seconds: 10,
          trim_start_seconds: 5,
          trim_end_seconds: 10,
          created_at: NOW,
        },
      ]),
    );
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'clip-1', project_id: 'proj-1', sort_order: 0, trim_start_seconds: 0, trim_end_seconds: 5 }]),
    );

    const res = await request(app)
      .post('/api/projects/proj-1/clips/clip-1/split')
      .send({ original_trim_end: 5, new_trim_start: 5, new_trim_end: 10, new_sort_order: 1 });

    expect(res.status).toBe(201);
    expect(res.body.clip.id).toBe('clip-2');
    expect(res.body.original_clip.trim_end_seconds).toBe(5);
    const copyCall = r2Mock.send.mock.calls.find((c) => c[0] instanceof CopyObjectCommand);
    expect(copyCall).toBeDefined();
    expect(copyCall![0].input.Key).toMatch(/^projects\/proj-1\/clips\//);
    expect(copyCall![0].input.CopySource).toBe('test-bucket/projects/proj-1/clips/a.mp4');
  });

  it('rejects with 400 when the split point is not strictly inside the clip trim range — no CopyObject sent', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 1 }]))
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([baseClipRow({ trim_start_seconds: 0, trim_end_seconds: 10 })]));

    const res = await request(app)
      .post('/api/projects/proj-1/clips/clip-1/split')
      .send({ original_trim_end: 10, new_trim_start: 10, new_trim_end: 15, new_sort_order: 1 });

    expect(res.status).toBe(400);
    const copyCalls = r2Mock.send.mock.calls.filter((c) => c[0] instanceof CopyObjectCommand);
    expect(copyCalls).toHaveLength(0);
  });

  it('rejects with 400 when required numeric fields are missing, never touching the db', async () => {
    const res = await request(app).post('/api/projects/proj-1/clips/clip-1/split').send({});

    expect(res.status).toBe(400);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the project already holds the maximum clip count', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])).mockReturnValueOnce(makeChain([{ count: 50 }]));

    const res = await request(app)
      .post('/api/projects/proj-1/clips/clip-1/split')
      .send({ original_trim_end: 5, new_trim_start: 0, new_trim_end: 5, new_sort_order: 1 });

    expect(res.status).toBe(400);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app)
      .post('/api/projects/not-mine/clips/clip-1/split')
      .send({ original_trim_end: 5, new_trim_start: 0, new_trim_end: 5, new_sort_order: 1 });

    expect(res.status).toBe(404);
  });

  it('returns 404 when the clip does not exist', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 1 }]))
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([]));

    const res = await request(app)
      .post('/api/projects/proj-1/clips/missing-clip/split')
      .send({ original_trim_end: 5, new_trim_start: 0, new_trim_end: 5, new_sort_order: 1 });

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/projects/:id/export ─────────────────────────────────────────────

function baseClipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clip-1',
    project_id: 'proj-1',
    sort_order: 0,
    r2_key: 'projects/proj-1/clips/a.mp4',
    media_type: 'video',
    source_type: 'upload',
    original_duration_seconds: 10,
    trim_start_seconds: 0,
    trim_end_seconds: 5,
    created_at: NOW,
    ...overrides,
  };
}

describe('POST /api/projects/:id/export', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(unauthApp).post('/api/projects/proj-1/export').send({});
    expect(res.status).toBe(401);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([])); // ownership lookup empty

    const res = await request(app).post('/api/projects/proj-1/export').send({});

    expect(res.status).toBe(404);
    expect(mockCreateGeneration).not.toHaveBeenCalled();
    expect(mockFfmpegQueueAdd).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the project has zero clips, never creating a generation', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{ count: 0 }])); // clip count

    const res = await request(app).post('/api/projects/proj-1/export').send({});

    expect(res.status).toBe(400);
    expect(mockCreateGeneration).not.toHaveBeenCalled();
  });

  it('happy path: snapshots project state, creates a free generation, enqueues compose, and NEVER updates the project row', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project (route-level check)
      .mockReturnValueOnce(makeChain([{ count: 1 }])) // clip count
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1' })])) // buildComposeSnapshot's project row
      .mockReturnValueOnce(makeChain([baseClipRow()])) // clips
      .mockReturnValueOnce(makeChain([])) // text overlays
      .mockReturnValueOnce(makeChain([])) // audio clips
      .mockReturnValueOnce(makeChain([])); // caption cues (empty => no word query)
    mockCreateGeneration.mockResolvedValueOnce({ id: 'gen-export-1' });

    const res = await request(app).post('/api/projects/proj-1/export').send({});

    expect(res.status).toBe(202);
    expect(res.body.generation_id).toBe('gen-export-1');

    expect(mockCreateGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'test-db-user-id',
        status: 'processing',
        cost_credits: 0,
        media_type: 'video',
        params: expect.objectContaining({ export_of_project_id: 'proj-1' }),
      }),
    );

    expect(mockFfmpegQueueAdd).toHaveBeenCalledWith(
      'compose-job',
      expect.objectContaining({
        generationId: 'gen-export-1',
        op: 'compose',
        costCredits: 0,
        mediaType: 'video',
        compose: expect.objectContaining({
          aspectRatio: '9:16',
          clips: [
            expect.objectContaining({
              r2Key: 'projects/proj-1/clips/a.mp4',
              mediaType: 'video',
              trimStartSeconds: 0,
              trimEndSeconds: 5,
            }),
          ],
        }),
      }),
    );

    // D-12: export never locks/consumes the project — no db.update call anywhere in this flow.
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('rejects with 400 when a clip has no resolvable trim_end_seconds (ExportValidationError)', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{ count: 1 }])) // clip count
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1' })])) // project row
      .mockReturnValueOnce(
        makeChain([baseClipRow({ trim_end_seconds: null, original_duration_seconds: null })]),
      ) // clips — no resolvable duration
      .mockReturnValueOnce(makeChain([])) // text overlays
      .mockReturnValueOnce(makeChain([])) // audio clips
      .mockReturnValueOnce(makeChain([])); // caption cues

    const res = await request(app).post('/api/projects/proj-1/export').send({});

    expect(res.status).toBe(400);
    expect(mockCreateGeneration).not.toHaveBeenCalled();
    expect(mockFfmpegQueueAdd).not.toHaveBeenCalled();
  });
});

// ─── POST /api/projects/:id/text ────────────────────────────────────────────────

describe('POST /api/projects/:id/text', () => {
  it('rejects an out-of-range x_norm (1.5) with 400 and never touches the db (T-13-44)', async () => {
    const res = await request(app)
      .post('/api/projects/proj-1/text')
      .send({ text: 'Hi', x_norm: 1.5, y_norm: 0.5, start_seconds: 0, end_seconds: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x_norm\/y_norm must be between 0 and 1/);
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range width_norm (5) with 400 and never touches the db', async () => {
    const res = await request(app)
      .post('/api/projects/proj-1/text')
      .send({ text: 'Hi', x_norm: 0.5, y_norm: 0.5, width_norm: 5, start_seconds: 0, end_seconds: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/width_norm must be between 0.5 and 3/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range rotation (400) with 400 and never touches the db (T-13-19 Task G3)', async () => {
    const res = await request(app)
      .post('/api/projects/proj-1/text')
      .send({ text: 'Hi', x_norm: 0.5, y_norm: 0.5, rotation: 400, start_seconds: 0, end_seconds: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rotation must be between -360 and 360/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('accepts a rotation within -360..360 and threads it through to addTextOverlay', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]))
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]));
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        {
          id: 'text-rot',
          project_id: 'proj-1',
          text: 'Hi',
          x_norm: 0.5,
          y_norm: 0.5,
          width_norm: 1,
          rotation: 45,
          start_seconds: 0,
          end_seconds: 2,
          created_at: NOW,
        },
      ]),
    );

    const res = await request(app)
      .post('/api/projects/proj-1/text')
      .send({ text: 'Hi', x_norm: 0.5, y_norm: 0.5, rotation: 45, start_seconds: 0, end_seconds: 2 });

    expect(res.status).toBe(201);
    expect(res.body.text_overlay.rotation).toBe(45);
    expect(dbMock.insert).toHaveBeenCalled();
    const insertedValues = dbMock.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(insertedValues.rotation).toBe(45);
  });

  it('rejects invalid start_seconds/end_seconds with 400', async () => {
    const res = await request(app)
      .post('/api/projects/proj-1/text')
      .send({ text: 'Hi', x_norm: 0.5, y_norm: 0.5, start_seconds: 5, end_seconds: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid start_seconds\/end_seconds/);
  });

  it('accepts boundary values (x_norm 0/1, width_norm 0.5/3) with 201', async () => {
    const boundaryCases = [
      { x_norm: 0, y_norm: 0.5 },
      { x_norm: 1, y_norm: 0.5 },
      { x_norm: 0.5, y_norm: 0.5, width_norm: 0.5 },
      { x_norm: 0.5, y_norm: 0.5, width_norm: 3 },
    ];
    for (let i = 0; i < boundaryCases.length; i++) {
      dbMock.select
        .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // route ownership check
        .mockReturnValueOnce(makeChain([{ count: 0 }])) // cap check
        .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // addTextOverlay's internal ownership check
      dbMock.insert.mockReturnValueOnce(
        makeChain([
          {
            id: `text-${i}`,
            project_id: 'proj-1',
            text: 'Hi',
            x_norm: 0,
            y_norm: 0,
            width_norm: null,
            start_seconds: 0,
            end_seconds: 2,
            created_at: NOW,
          },
        ]),
      );

      const res = await request(app)
        .post('/api/projects/proj-1/text')
        .send({ text: 'Hi', start_seconds: 0, end_seconds: 2, ...boundaryCases[i] });

      expect(res.status).toBe(201);
    }
  });

  it('happy path: 201 with the created text overlay', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]))
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]));
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        {
          id: 'text-1',
          project_id: 'proj-1',
          text: 'Hello',
          x_norm: 0.5,
          y_norm: 0.5,
          width_norm: 1,
          start_seconds: 0,
          end_seconds: 3,
          created_at: NOW,
        },
      ]),
    );

    const res = await request(app)
      .post('/api/projects/proj-1/text')
      .send({ text: 'Hello', x_norm: 0.5, y_norm: 0.5, width_norm: 1, start_seconds: 0, end_seconds: 3 });

    expect(res.status).toBe(201);
    expect(res.body.text_overlay.id).toBe('text-1');
  });

  it('rejects with 400 when the project already holds the maximum text overlay count', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 30 }]));

    const res = await request(app)
      .post('/api/projects/proj-1/text')
      .send({ text: 'Hi', x_norm: 0.5, y_norm: 0.5, start_seconds: 0, end_seconds: 2 });

    expect(res.status).toBe(400);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([])); // ownership check empty

    const res = await request(app)
      .post('/api/projects/not-mine/text')
      .send({ text: 'Hi', x_norm: 0.5, y_norm: 0.5, start_seconds: 0, end_seconds: 2 });

    expect(res.status).toBe(404);
  });
});

// ─── PATCH /api/projects/:id/text/:textId ──────────────────────────────────────

describe('PATCH /api/projects/:id/text/:textId', () => {
  it('updates a text overlay and returns 200', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // isProjectOwned
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'text-1', project_id: 'proj-1', text: 'Edited', x_norm: 0.5, y_norm: 0.5 }]),
    );

    const res = await request(app).patch('/api/projects/proj-1/text/text-1').send({ text: 'Edited' });

    expect(res.status).toBe(200);
    expect(res.body.text_overlay.text).toBe('Edited');
  });

  it('rejects an out-of-range x_norm with 400 and never touches the db', async () => {
    const res = await request(app).patch('/api/projects/proj-1/text/text-1').send({ x_norm: -0.1 });

    expect(res.status).toBe(400);
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range width_norm with 400', async () => {
    const res = await request(app).patch('/api/projects/proj-1/text/text-1').send({ width_norm: 0.1 });

    expect(res.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range rotation with 400 (T-13-19 Task G3)', async () => {
    const res = await request(app).patch('/api/projects/proj-1/text/text-1').send({ rotation: -400 });

    expect(res.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('updates rotation and returns 200', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // isProjectOwned
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'text-1', project_id: 'proj-1', text: 'Hi', rotation: -30 }]),
    );

    const res = await request(app).patch('/api/projects/proj-1/text/text-1').send({ rotation: -30 });

    expect(res.status).toBe(200);
    expect(res.body.text_overlay.rotation).toBe(-30);
  });

  it('returns 404 for a mutation on a project owned by another user (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([])); // isProjectOwned returns false

    const res = await request(app).patch('/api/projects/not-mine/text/text-1').send({ text: 'Hijacked' });

    expect(res.status).toBe(404);
  });
});

// ─── DELETE /api/projects/:id/text/:textId ─────────────────────────────────────

describe('DELETE /api/projects/:id/text/:textId', () => {
  it('returns 204 on success', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // isProjectOwned
    dbMock.delete.mockReturnValueOnce(makeChain([{ id: 'text-1' }]));

    const res = await request(app).delete('/api/projects/proj-1/text/text-1');

    expect(res.status).toBe(204);
  });

  it('returns 404 when not owned', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app).delete('/api/projects/not-mine/text/text-1');

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/projects/:id/audio ──────────────────────────────────────────────

describe('POST /api/projects/:id/audio', () => {
  it('upload path: writes to R2 via PutObjectCommand and inserts an audio clip row', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned
      .mockReturnValueOnce(makeChain([{ count: 0 }])) // cap check
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // addAudioClip's ownership check
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 0 }] });
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        {
          id: 'audio-1',
          project_id: 'proj-1',
          r2_key: 'projects/proj-1/audio/new.mp3',
          source_type: 'upload',
          start_offset_seconds: 0,
          trim_start_seconds: 0,
          trim_end_seconds: null,
          sort_order: 0,
          created_at: NOW,
        },
      ]),
    );

    const res = await request(app)
      .post('/api/projects/proj-1/audio')
      .attach('file', Buffer.from('fake-mp3'), { filename: 'a.mp3', contentType: 'audio/mpeg' });

    expect(res.status).toBe(201);
    const putCall = r2Mock.send.mock.calls.find((c) => c[0] instanceof PutObjectCommand);
    expect(putCall).toBeDefined();
    expect(putCall![0].input.Key).toMatch(/^projects\/proj-1\/audio\//);
  });

  it('preset-music path: copies the preset track via CopyObjectCommand', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]))
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]));
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 0 }] });
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        {
          id: 'audio-2',
          project_id: 'proj-1',
          r2_key: 'projects/proj-1/audio/new.m4a',
          source_type: 'preset',
          start_offset_seconds: 5,
          trim_start_seconds: 0,
          trim_end_seconds: null,
          sort_order: 0,
          created_at: NOW,
        },
      ]),
    );

    const res = await request(app)
      .post('/api/projects/proj-1/audio')
      .send({ source_type: 'preset', preset_music_id: 'carefree', start_offset_seconds: 5 });

    expect(res.status).toBe(201);
    const copyCall = r2Mock.send.mock.calls.find((c) => c[0] instanceof CopyObjectCommand);
    expect(copyCall).toBeDefined();
    expect(copyCall![0].input.CopySource).toBe('test-bucket/preset-music/carefree.m4a');
    expect(copyCall![0].input.Key).toMatch(/^projects\/proj-1\/audio\/.*\.m4a$/);
  });

  it('rejects an unknown preset_music_id with 400', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]));

    const res = await request(app)
      .post('/api/projects/proj-1/audio')
      .send({ source_type: 'preset', preset_music_id: 'nonexistent-track' });

    expect(res.status).toBe(400);
    const copyCalls = r2Mock.send.mock.calls.filter((c) => c[0] instanceof CopyObjectCommand);
    expect(copyCalls).toHaveLength(0);
  });

  it('rejects with 400 when the project already holds the maximum audio clip count', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 10 }]));

    const res = await request(app)
      .post('/api/projects/proj-1/audio')
      .send({ source_type: 'preset', preset_music_id: 'carefree' });

    expect(res.status).toBe(400);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app)
      .post('/api/projects/not-mine/audio')
      .send({ source_type: 'preset', preset_music_id: 'carefree' });

    expect(res.status).toBe(404);
  });
});

// ─── PATCH /api/projects/:id/audio/:audioId ────────────────────────────────────

describe('PATCH /api/projects/:id/audio/:audioId', () => {
  it('updates an audio clip and returns 200', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // isProjectOwned
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'audio-1', project_id: 'proj-1', start_offset_seconds: 3, trim_start_seconds: 1 }]),
    );

    const res = await request(app)
      .patch('/api/projects/proj-1/audio/audio-1')
      .send({ start_offset_seconds: 3, trim_start_seconds: 1 });

    expect(res.status).toBe(200);
    expect(res.body.audio_clip.start_offset_seconds).toBe(3);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app)
      .patch('/api/projects/not-mine/audio/audio-1')
      .send({ start_offset_seconds: 3 });

    expect(res.status).toBe(404);
  });
});

// ─── DELETE /api/projects/:id/audio/:audioId ───────────────────────────────────

describe('DELETE /api/projects/:id/audio/:audioId', () => {
  it('returns 204 and deletes the R2 object', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // isProjectOwned
      .mockReturnValueOnce(makeChain([{ r2_key: 'projects/proj-1/audio/a1.mp3' }])); // r2_key lookup
    dbMock.delete.mockReturnValueOnce(makeChain(undefined));

    const res = await request(app).delete('/api/projects/proj-1/audio/audio-1');

    expect(res.status).toBe(204);
    const deleteCall = r2Mock.send.mock.calls.find((c) => c[0] instanceof DeleteObjectCommand);
    expect(deleteCall).toBeDefined();
    expect(deleteCall![0].input.Key).toBe('projects/proj-1/audio/a1.mp3');
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app).delete('/api/projects/not-mine/audio/audio-1');

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/projects/:id/audio/:audioId/split (T-13-19 Task G2) ────────────

function baseAudioRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audio-1',
    project_id: 'proj-1',
    r2_key: 'projects/proj-1/audio/a.mp3',
    source_type: 'upload',
    start_offset_seconds: 0,
    trim_start_seconds: 0,
    trim_end_seconds: 10,
    sort_order: 0,
    created_at: NOW,
    ...overrides,
  };
}

describe('POST /api/projects/:id/audio/:audioId/split', () => {
  it('happy path: CopyObjects the source r2_key, appends the new audio clip, and shrinks the original trim_end', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // route ownership check
      .mockReturnValueOnce(makeChain([{ count: 1 }])) // cap check
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // splitAudioClip's isProjectOwned
      .mockReturnValueOnce(makeChain([baseAudioRow()])); // audio clip lookup
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 1 }] }); // nextSortOrder
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        {
          id: 'audio-2',
          project_id: 'proj-1',
          r2_key: 'projects/proj-1/audio/new-uuid.mp3',
          source_type: 'upload',
          start_offset_seconds: 5,
          trim_start_seconds: 0,
          trim_end_seconds: 5,
          sort_order: 1,
          created_at: NOW,
        },
      ]),
    );
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'audio-1', project_id: 'proj-1', trim_start_seconds: 0, trim_end_seconds: 5 }]),
    );

    const res = await request(app)
      .post('/api/projects/proj-1/audio/audio-1/split')
      .send({ original_trim_end: 5, new_trim_start: 0, new_trim_end: 5, new_start_offset_seconds: 5 });

    expect(res.status).toBe(201);
    expect(res.body.audio_clip.id).toBe('audio-2');
    expect(res.body.original_audio_clip.trim_end_seconds).toBe(5);
    const copyCall = r2Mock.send.mock.calls.find((c) => c[0] instanceof CopyObjectCommand);
    expect(copyCall).toBeDefined();
    expect(copyCall![0].input.Key).toMatch(/^projects\/proj-1\/audio\//);
    expect(copyCall![0].input.CopySource).toBe('test-bucket/projects/proj-1/audio/a.mp3');
  });

  it('rejects with 400 when the split point is not strictly inside the audio clip trim range', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 1 }]))
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([baseAudioRow()]));

    const res = await request(app)
      .post('/api/projects/proj-1/audio/audio-1/split')
      .send({ original_trim_end: 0, new_trim_start: 0, new_trim_end: 5, new_start_offset_seconds: 0 });

    expect(res.status).toBe(400);
    const copyCalls = r2Mock.send.mock.calls.filter((c) => c[0] instanceof CopyObjectCommand);
    expect(copyCalls).toHaveLength(0);
  });

  it('rejects with 400 when required numeric fields are missing, never touching the db', async () => {
    const res = await request(app).post('/api/projects/proj-1/audio/audio-1/split').send({});

    expect(res.status).toBe(400);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the project already holds the maximum audio clip count', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])).mockReturnValueOnce(makeChain([{ count: 10 }]));

    const res = await request(app)
      .post('/api/projects/proj-1/audio/audio-1/split')
      .send({ original_trim_end: 5, new_trim_start: 0, new_trim_end: 5, new_start_offset_seconds: 5 });

    expect(res.status).toBe(400);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app)
      .post('/api/projects/not-mine/audio/audio-1/split')
      .send({ original_trim_end: 5, new_trim_start: 0, new_trim_end: 5, new_start_offset_seconds: 5 });

    expect(res.status).toBe(404);
  });

  it('returns 404 when the audio clip does not exist', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 1 }]))
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([]));

    const res = await request(app)
      .post('/api/projects/proj-1/audio/missing-audio/split')
      .send({ original_trim_end: 5, new_trim_start: 0, new_trim_end: 5, new_start_offset_seconds: 5 });

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/projects/:id/captions ───────────────────────────────────────────

describe('POST /api/projects/:id/captions', () => {
  it('happy path: creates a cue with its words and returns 201', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned
      .mockReturnValueOnce(makeChain([{ count: 0 }])) // cap check
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // addCaptionCue's ownership check
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 0 }] });
    dbMock.insert
      .mockReturnValueOnce(
        makeChain([{ id: 'cue-1', project_id: 'proj-1', sort_order: 0, start_seconds: 0, end_seconds: 1.2, created_at: NOW }]),
      ) // cue insert
      .mockReturnValueOnce(
        makeChain([
          { id: 'word-1', cue_id: 'cue-1', text: 'hi', start_seconds: 0, end_seconds: 0.6, sort_order: 0 },
          { id: 'word-2', cue_id: 'cue-1', text: 'there', start_seconds: 0.6, end_seconds: 1.2, sort_order: 1 },
        ]),
      ); // words insert

    const res = await request(app)
      .post('/api/projects/proj-1/captions')
      .send({
        start_seconds: 0,
        end_seconds: 1.2,
        words: [
          { text: 'hi', start_seconds: 0, end_seconds: 0.6 },
          { text: 'there', start_seconds: 0.6, end_seconds: 1.2 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.caption_cue.id).toBe('cue-1');
    expect(res.body.caption_cue.words).toHaveLength(2);
  });

  it('rejects invalid start_seconds/end_seconds with 400', async () => {
    const res = await request(app).post('/api/projects/proj-1/captions').send({ start_seconds: 5, end_seconds: 1 });

    expect(res.status).toBe(400);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('rejects a malformed word entry with 400', async () => {
    const res = await request(app)
      .post('/api/projects/proj-1/captions')
      .send({ start_seconds: 0, end_seconds: 1, words: [{ text: 'hi', start_seconds: 1, end_seconds: 0.5 }] });

    expect(res.status).toBe(400);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app).post('/api/projects/not-mine/captions').send({ start_seconds: 0, end_seconds: 1 });

    expect(res.status).toBe(404);
  });
});

// ─── PATCH /api/projects/:id/captions/:cueId ───────────────────────────────────

describe('PATCH /api/projects/:id/captions/:cueId', () => {
  it('retimes a cue and replaces its word list, returns 200', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // isProjectOwned
      .mockReturnValueOnce(
        makeChain([{ id: 'cue-1', project_id: 'proj-1', sort_order: 0, start_seconds: 0, end_seconds: 1.2, created_at: NOW }]),
      ); // existing cue lookup
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'cue-1', project_id: 'proj-1', sort_order: 0, start_seconds: 0.5, end_seconds: 2, created_at: NOW }]),
    );
    dbMock.delete.mockReturnValueOnce(makeChain(undefined)); // delete old words
    dbMock.insert.mockReturnValueOnce(
      makeChain([{ id: 'word-3', cue_id: 'cue-1', text: 'new', start_seconds: 0.5, end_seconds: 2, sort_order: 0 }]),
    ); // new words

    const res = await request(app)
      .patch('/api/projects/proj-1/captions/cue-1')
      .send({ start_seconds: 0.5, end_seconds: 2, words: [{ text: 'new', start_seconds: 0.5, end_seconds: 2 }] });

    expect(res.status).toBe(200);
    expect(res.body.caption_cue.start_seconds).toBe(0.5);
    expect(res.body.caption_cue.words).toEqual([
      expect.objectContaining({ text: 'new' }),
    ]);
  });

  it('returns 404 when the cue does not exist', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // isProjectOwned
      .mockReturnValueOnce(makeChain([])); // existing cue lookup empty

    const res = await request(app).patch('/api/projects/proj-1/captions/nope').send({ start_seconds: 0, end_seconds: 1 });

    expect(res.status).toBe(404);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app).patch('/api/projects/not-mine/captions/cue-1').send({ start_seconds: 0, end_seconds: 1 });

    expect(res.status).toBe(404);
  });
});

// ─── DELETE /api/projects/:id/captions/:cueId (single) ─────────────────────────

describe('DELETE /api/projects/:id/captions/:cueId', () => {
  it('returns 204 on success', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // isProjectOwned
      .mockReturnValueOnce(makeChain([{ id: 'cue-1' }])); // existing cue lookup
    dbMock.delete.mockReturnValue(makeChain(undefined));

    const res = await request(app).delete('/api/projects/proj-1/captions/cue-1');

    expect(res.status).toBe(204);
  });

  it('returns 404 when not found', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([]));

    const res = await request(app).delete('/api/projects/proj-1/captions/nope');

    expect(res.status).toBe(404);
  });
});

// ─── DELETE /api/projects/:id/captions (bulk — D-13) ───────────────────────────

describe('DELETE /api/projects/:id/captions (bulk Delete All Captions)', () => {
  it('clears ALL caption cues + words for the project in one call, not per-line (D-13)', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // isProjectOwned
      .mockReturnValueOnce(makeChain([{ id: 'cue-1' }, { id: 'cue-2' }, { id: 'cue-3' }])); // all cue ids
    dbMock.delete.mockReturnValue(makeChain(undefined));

    const res = await request(app).delete('/api/projects/proj-1/captions');

    expect(res.status).toBe(204);
    // exactly 2 delete calls total regardless of cue count (bulk words delete + bulk cues
    // delete) — proves this is a single bulk operation, never a per-cue loop
    expect(dbMock.delete).toHaveBeenCalledTimes(2);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app).delete('/api/projects/not-mine/captions');

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/projects/:id/clips/:clipId/captions/auto-generate (SC5) ────────

describe('POST /api/projects/:id/clips/:clipId/captions/auto-generate', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(unauthApp).post('/api/projects/proj-1/clips/clip-1/captions/auto-generate');
    expect(res.status).toBe(401);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([])); // ownership lookup empty

    const res = await request(app).post('/api/projects/not-mine/clips/clip-1/captions/auto-generate');

    expect(res.status).toBe(404);
    expect(mockTranscribeToWordCues).not.toHaveBeenCalled();
  });

  it('returns 404 when the clip does not exist on the project', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([])); // clip lookup empty

    const res = await request(app).post('/api/projects/proj-1/clips/nope/captions/auto-generate');

    expect(res.status).toBe(404);
    expect(mockTranscribeToWordCues).not.toHaveBeenCalled();
  });

  it('happy path: transcribes the clip and persists each returned cue via addCaptionCue, 200', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{ r2_key: 'projects/proj-1/clips/a.mp4' }])) // clip lookup
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // addCaptionCue's internal isProjectOwned
    mockTranscribeToWordCues.mockResolvedValueOnce([
      {
        startSeconds: 0,
        endSeconds: 1.2,
        words: [
          { text: 'hi', startSeconds: 0, endSeconds: 0.6 },
          { text: 'there', startSeconds: 0.6, endSeconds: 1.2 },
        ],
      },
    ]);
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 0 }] });
    dbMock.insert
      .mockReturnValueOnce(
        makeChain([{ id: 'cue-1', project_id: 'proj-1', sort_order: 0, start_seconds: 0, end_seconds: 1.2, created_at: NOW }]),
      ) // cue insert
      .mockReturnValueOnce(
        makeChain([
          { id: 'word-1', cue_id: 'cue-1', text: 'hi', start_seconds: 0, end_seconds: 0.6, sort_order: 0 },
          { id: 'word-2', cue_id: 'cue-1', text: 'there', start_seconds: 0.6, end_seconds: 1.2, sort_order: 1 },
        ]),
      ); // words insert

    const res = await request(app).post('/api/projects/proj-1/clips/clip-1/captions/auto-generate');

    expect(res.status).toBe(200);
    expect(mockTranscribeToWordCues).toHaveBeenCalledWith('projects/proj-1/clips/a.mp4');
    expect(res.body.cues).toHaveLength(1);
    expect(res.body.cues[0].id).toBe('cue-1');
    expect(res.body.cues[0].words).toHaveLength(2);
  });

  it('returns 502 when transcription fails, and never calls addCaptionCue', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{ r2_key: 'projects/proj-1/clips/a.mp4' }])); // clip lookup
    mockTranscribeToWordCues.mockRejectedValueOnce(new TranscriptionError('OpenAI transcription failed (500): boom'));

    const res = await request(app).post('/api/projects/proj-1/clips/clip-1/captions/auto-generate');

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Transcription failed');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

// ─── smartUnpackOnImport (D-15/D-16) — direct service-level unit tests ─────────

describe('smartUnpackOnImport', () => {
  it('inserts caption cue/word rows AND audio clip rows from a structured source generation', async () => {
    dbMock.insert
      .mockReturnValueOnce(makeChain(undefined)) // audio clip insert (values only, no .returning())
      .mockReturnValueOnce(makeChain([{ id: 'cue-1' }])) // caption cue insert (.returning())
      .mockReturnValueOnce(makeChain(undefined)); // caption word insert (values only)

    const result = await smartUnpackOnImport('proj-1', {
      id: 'gen-structured',
      params: {
        structured: {
          audioStems: [{ r2Key: 'generations/gen-structured.narration.mp3', sourceType: 'narration', startOffsetSeconds: 0 }],
          captionCues: [
            {
              startSeconds: 0,
              endSeconds: 1.2,
              words: [
                { text: 'hi', startSeconds: 0, endSeconds: 0.6 },
                { text: 'there', startSeconds: 0.6, endSeconds: 1.2 },
              ],
            },
          ],
        },
      },
    });

    expect(result.unpacked).toBe(true);
    expect(dbMock.insert).toHaveBeenCalledTimes(3);

    const copyCall = r2Mock.send.mock.calls.find((c) => c[0] instanceof CopyObjectCommand);
    expect(copyCall).toBeDefined();
    expect(copyCall![0].input.Key).toMatch(/^projects\/proj-1\/audio\//);

    // Caption cue insert received the cue's start/end
    const cueInsertReturn = dbMock.insert.mock.results[1].value as { values: jest.Mock };
    expect(cueInsertReturn.values).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'proj-1', start_seconds: 0, end_seconds: 1.2 }),
    );

    // Caption word insert received both words scoped to cue-1
    const wordInsertReturn = dbMock.insert.mock.results[2].value as { values: jest.Mock };
    expect(wordInsertReturn.values).toHaveBeenCalledWith([
      expect.objectContaining({ cue_id: 'cue-1', text: 'hi' }),
      expect.objectContaining({ cue_id: 'cue-1', text: 'there' }),
    ]);
  });

  it('is a no-op for a plain generation with no structured marker (no caption/audio rows inserted)', async () => {
    const result = await smartUnpackOnImport('proj-1', { id: 'gen-plain', params: { resolution: '720p' } });

    expect(result.unpacked).toBe(false);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(r2Mock.send).not.toHaveBeenCalled();
  });

  it('is a no-op when params is null', async () => {
    const result = await smartUnpackOnImport('proj-1', { id: 'gen-null', params: null });

    expect(result.unpacked).toBe(false);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});
