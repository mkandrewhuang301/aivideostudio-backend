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

// Plan 13-20 B1/B3 (extended by Plan 13-22 B1): probeDurationSeconds/probeVideoMeta spawn a real
// ffprobe process — mocked at the module boundary so route/service tests stay deterministic and
// offline. Both default to a null/no-probe result so tests that don't care about them behave like
// a probe failure; individual tests override with mockResolvedValueOnce.
const mockProbeDurationSeconds = jest.fn().mockResolvedValue(null);
const mockProbeVideoMeta = jest.fn().mockResolvedValue({ durationSeconds: null, width: null, height: null });
jest.mock('../../services/mediaProbe', () => ({
  probeDurationSeconds: (...args: unknown[]) => mockProbeDurationSeconds(...args),
  probeVideoMeta: (...args: unknown[]) => mockProbeVideoMeta(...args),
}));

// Plan 13-21 B3: extractVideoFrame spawns a real ffmpeg process (download + frame grab) — mocked
// at the module boundary so the cover-endpoint tests stay deterministic and offline.
const mockExtractVideoFrame = jest.fn().mockResolvedValue('generations/project-cover-mocked.png');
jest.mock('../../services/frameExtractor', () => ({
  extractVideoFrame: (...args: unknown[]) => mockExtractVideoFrame(...args),
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
import { smartUnpackOnImport, translateCaptionDraftsToProjectTimeline } from '../../services/projectService';
import { TranscriptionError } from '../../services/captionTranscriptionService';
import { r2 } from '../../storage/r2';
import { db } from '../../db/client';
import { projectClips } from '../../db/schema';

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

  it("B2 (13-22): defaults a new project's aspect_ratio to 'original' when none is provided", async () => {
    const valuesFn = jest.fn().mockReturnValue(makeChain([baseProjectRow({ id: 'new-proj-2', aspect_ratio: 'original' })]));
    dbMock.insert.mockReturnValueOnce({ values: valuesFn });

    const res = await request(app).post('/api/projects').send({ title: 'My Video' });

    expect(res.status).toBe(201);
    expect(valuesFn).toHaveBeenCalledWith(expect.objectContaining({ aspect_ratio: 'original' }));
  });

  it("B2 (13-22): accepts an explicit aspectRatio: 'original' on create", async () => {
    dbMock.insert.mockReturnValueOnce(makeChain([baseProjectRow({ id: 'new-proj-3', aspect_ratio: 'original' })]));

    const res = await request(app).post('/api/projects').send({ aspectRatio: 'original' });

    expect(res.status).toBe(201);
    expect(res.body.project.aspect_ratio).toBe('original');
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
      .mockReturnValueOnce(makeChain([])) // B1.5 purge: expired clips (none)
      .mockReturnValueOnce(makeChain([])) // B1.5 purge: expired audio (none)
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

  it('B1.4 self-heal: backfills a null-duration/dimension video clip by probing its presigned url and persisting the result', async () => {
    const setFn = jest.fn().mockReturnValue(makeChain([]));
    dbMock.update.mockReturnValueOnce({ set: setFn });
    mockProbeVideoMeta.mockResolvedValueOnce({ durationSeconds: 7.8, width: 1080, height: 1920 });

    dbMock.select
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1' })])) // project row
      .mockReturnValueOnce(makeChain([])) // B1.5 purge: expired clips (none)
      .mockReturnValueOnce(makeChain([])) // B1.5 purge: expired audio (none)
      .mockReturnValueOnce(
        makeChain([
          { id: 'clip-heal', project_id: 'proj-1', sort_order: 0, r2_key: 'projects/proj-1/clips/a.mp4', media_type: 'video', source_type: 'upload', original_duration_seconds: null, width: null, height: null, trim_start_seconds: 0, trim_end_seconds: null, created_at: NOW },
        ]),
      ) // clips
      .mockReturnValueOnce(makeChain([])) // text overlays
      .mockReturnValueOnce(makeChain([])) // audio clips
      .mockReturnValueOnce(makeChain([])); // caption cues

    const res = await request(app).get('/api/projects/proj-1');

    expect(res.status).toBe(200);
    expect(mockProbeVideoMeta).toHaveBeenCalledWith('https://r2.example.com/presigned-clip-url');
    expect(res.body.project.clips[0].original_duration_seconds).toBe(7.8);
    expect(res.body.project.clips[0].width).toBe(1080);
    expect(res.body.project.clips[0].height).toBe(1920);
    expect(dbMock.update).toHaveBeenCalled();
    const setArg = setFn.mock.calls[0][0];
    expect(setArg).toEqual({ original_duration_seconds: 7.8, width: 1080, height: 1920 });
  });

  it('B1.4 self-heal: an image clip with a null duration is backfilled to 3s without probing duration, but IS probed for dimensions', async () => {
    const setFn = jest.fn().mockReturnValue(makeChain([]));
    dbMock.update.mockReturnValueOnce({ set: setFn });
    mockProbeVideoMeta.mockResolvedValueOnce({ durationSeconds: null, width: 800, height: 600 });

    dbMock.select
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1' })]))
      .mockReturnValueOnce(makeChain([])) // B1.5 purge: expired clips (none)
      .mockReturnValueOnce(makeChain([])) // B1.5 purge: expired audio (none)
      .mockReturnValueOnce(
        makeChain([
          { id: 'clip-heal-img', project_id: 'proj-1', sort_order: 0, r2_key: 'projects/proj-1/clips/a.jpg', media_type: 'image', source_type: 'upload', original_duration_seconds: null, width: null, height: null, trim_start_seconds: 0, trim_end_seconds: null, created_at: NOW },
        ]),
      )
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]));

    const res = await request(app).get('/api/projects/proj-1');

    expect(res.status).toBe(200);
    // Duration is hardcoded 3s for images without needing a probed duration value, but the SAME
    // probe call still resolves width/height (ffprobe reads image dimensions too).
    expect(mockProbeVideoMeta).toHaveBeenCalledWith('https://r2.example.com/presigned-clip-url');
    expect(res.body.project.clips[0].original_duration_seconds).toBe(3);
    expect(res.body.project.clips[0].width).toBe(800);
    expect(res.body.project.clips[0].height).toBe(600);
  });

  it('B1.4 self-heal: a probe failure still returns the project with a null duration/dimensions (never 500s)', async () => {
    mockProbeVideoMeta.mockResolvedValueOnce({ durationSeconds: null, width: null, height: null });

    dbMock.select
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1' })]))
      .mockReturnValueOnce(makeChain([])) // B1.5 purge: expired clips (none)
      .mockReturnValueOnce(makeChain([])) // B1.5 purge: expired audio (none)
      .mockReturnValueOnce(
        makeChain([
          { id: 'clip-heal-fail', project_id: 'proj-1', sort_order: 0, r2_key: 'projects/proj-1/clips/a.mp4', media_type: 'video', source_type: 'upload', original_duration_seconds: null, width: null, height: null, trim_start_seconds: 0, trim_end_seconds: null, created_at: NOW },
        ]),
      )
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]));

    const res = await request(app).get('/api/projects/proj-1');

    expect(res.status).toBe(200);
    expect(res.body.project.clips[0].original_duration_seconds).toBeNull();
    expect(res.body.project.clips[0].width).toBeNull();
    expect(res.body.project.clips[0].height).toBeNull();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('B1.5 purge: reaps a clip + audio clip soft-deleted past 24h (best-effort R2 delete + hard row delete)', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1' })])) // project row
      .mockReturnValueOnce(makeChain([{ id: 'expired-clip', r2_key: 'projects/proj-1/clips/old.mp4' }])) // purge: expired clips
      .mockReturnValueOnce(makeChain([{ id: 'expired-audio', r2_key: 'projects/proj-1/audio/old.mp3' }])) // purge: expired audio
      .mockReturnValueOnce(makeChain([])) // clips (post-purge, none active)
      .mockReturnValueOnce(makeChain([])) // text overlays
      .mockReturnValueOnce(makeChain([])) // audio clips (post-purge, none active)
      .mockReturnValueOnce(makeChain([])); // caption cues
    dbMock.delete.mockReturnValue(makeChain(undefined));

    const res = await request(app).get('/api/projects/proj-1');

    expect(res.status).toBe(200);
    const clipDeleteCall = r2Mock.send.mock.calls.find(
      (c) => c[0] instanceof DeleteObjectCommand && c[0].input.Key === 'projects/proj-1/clips/old.mp4',
    );
    const audioDeleteCall = r2Mock.send.mock.calls.find(
      (c) => c[0] instanceof DeleteObjectCommand && c[0].input.Key === 'projects/proj-1/audio/old.mp3',
    );
    expect(clipDeleteCall).toBeDefined();
    expect(audioDeleteCall).toBeDefined();
    expect(dbMock.delete).toHaveBeenCalledTimes(2); // one hard-delete per expired row
  });

  it("doesn't leak a soft-deleted (but not-yet-purged) clip into the response", async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1' })])) // project row
      .mockReturnValueOnce(makeChain([])) // purge: no expired clips
      .mockReturnValueOnce(makeChain([])) // purge: no expired audio
      // clips query is scoped with deleted_at IS NULL — a just-deleted (not yet 24h expired) row
      // is excluded at the query level, so the mocked "active clips" result is simply empty here.
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]));

    const res = await request(app).get('/api/projects/proj-1');

    expect(res.status).toBe(200);
    expect(res.body.project.clips).toHaveLength(0);
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

  it("B2 (13-22): accepts 'original' as a valid aspect_ratio with 200", async () => {
    const setFn = jest.fn().mockReturnValue(makeChain([baseProjectRow({ aspect_ratio: 'original' })]));
    dbMock.update.mockReturnValueOnce({ set: setFn });

    const res = await request(app).patch('/api/projects/proj-1').send({ aspect_ratio: 'original' });

    expect(res.status).toBe(200);
    expect(res.body.project.aspect_ratio).toBe('original');
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

// ─── POST /api/projects/:id/cover (Plan 13-21 B3) ──────────────────────────────

describe('POST /api/projects/:id/cover', () => {
  it('video clip: extracts a frame via extractVideoFrame, updates thumbnail_r2_key, returns a fresh presigned url', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1', thumbnail_r2_key: 'generations/old-thumb.png' })])) // setProjectCover's project lookup
      .mockReturnValueOnce(
        makeChain([
          { id: 'clip-1', project_id: 'proj-1', r2_key: 'projects/proj-1/clips/a.mp4', media_type: 'video', original_duration_seconds: 10, deleted_at: null },
        ]),
      ); // clip lookup
    dbMock.update.mockReturnValueOnce(makeChain(undefined)); // set thumbnail_r2_key

    const res = await request(app).post('/api/projects/proj-1/cover').send({ clip_id: 'clip-1', at_seconds: 3 });

    expect(res.status).toBe(200);
    expect(res.body.thumbnail_url).toBe('https://r2.example.com/presigned-clip-url');
    expect(mockExtractVideoFrame).toHaveBeenCalledWith(
      'https://r2.example.com/presigned-clip-url',
      expect.stringMatching(/^project-cover-/),
      3,
    );
    const deleteCall = r2Mock.send.mock.calls.find(
      (c) => c[0] instanceof DeleteObjectCommand && c[0].input.Key === 'generations/old-thumb.png',
    );
    expect(deleteCall).toBeDefined(); // old thumbnail best-effort cleaned up
  });

  it('video clip: clamps at_seconds into the clip real duration', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1', thumbnail_r2_key: null })]))
      .mockReturnValueOnce(
        makeChain([
          { id: 'clip-1', project_id: 'proj-1', r2_key: 'projects/proj-1/clips/a.mp4', media_type: 'video', original_duration_seconds: 5, deleted_at: null },
        ]),
      );
    dbMock.update.mockReturnValueOnce(makeChain(undefined));

    const res = await request(app).post('/api/projects/proj-1/cover').send({ clip_id: 'clip-1', at_seconds: 999 });

    expect(res.status).toBe(200);
    expect(mockExtractVideoFrame).toHaveBeenCalledWith(expect.any(String), expect.any(String), 5); // clamped to duration
  });

  it('image clip: CopyObjects the clip r2_key to a fresh key (never reuses it directly)', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1', thumbnail_r2_key: null })]))
      .mockReturnValueOnce(
        makeChain([
          { id: 'clip-2', project_id: 'proj-1', r2_key: 'projects/proj-1/clips/b.jpg', media_type: 'image', original_duration_seconds: 3, deleted_at: null },
        ]),
      );
    dbMock.update.mockReturnValueOnce(makeChain(undefined));

    const res = await request(app).post('/api/projects/proj-1/cover').send({ clip_id: 'clip-2', at_seconds: 0 });

    expect(res.status).toBe(200);
    const copyCall = r2Mock.send.mock.calls.find((c) => c[0] instanceof CopyObjectCommand);
    expect(copyCall).toBeDefined();
    expect(copyCall![0].input.CopySource).toBe('test-bucket/projects/proj-1/clips/b.jpg');
    expect(copyCall![0].input.Key).not.toBe('projects/proj-1/clips/b.jpg');
    expect(mockExtractVideoFrame).not.toHaveBeenCalled();
  });

  it('returns 404 for a project owned by another user (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app).post('/api/projects/not-mine/cover').send({ clip_id: 'clip-1', at_seconds: 0 });

    expect(res.status).toBe(404);
  });

  it('returns 404 for a clip that does not exist / is soft-deleted', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1' })]))
      .mockReturnValueOnce(makeChain([])); // clip lookup empty (filtered out or missing)

    const res = await request(app).post('/api/projects/proj-1/cover').send({ clip_id: 'gone', at_seconds: 0 });

    expect(res.status).toBe(404);
  });

  it('rejects with 400 when clip_id/at_seconds are missing or invalid', async () => {
    const res1 = await request(app).post('/api/projects/proj-1/cover').send({ at_seconds: 0 });
    expect(res1.status).toBe(400);

    const res2 = await request(app).post('/api/projects/proj-1/cover').send({ clip_id: 'clip-1', at_seconds: -1 });
    expect(res2.status).toBe(400);

    expect(dbMock.select).not.toHaveBeenCalled();
  });

  // Plan 13-24 K-B1 — multipart cover upload branch
  it('K-B1 multipart: uploads image to projects/{id}/cover/, updates thumbnail_r2_key, returns presigned url', async () => {
    dbMock.select.mockReturnValueOnce(
      makeChain([baseProjectRow({ id: 'proj-1', thumbnail_r2_key: 'generations/old-cover.png' })]),
    );
    dbMock.update.mockReturnValueOnce(makeChain(undefined));

    const res = await request(app)
      .post('/api/projects/proj-1/cover')
      .attach('file', Buffer.from('fake-cover-jpg'), { filename: 'cover.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.thumbnail_url).toBe('https://r2.example.com/presigned-clip-url');
    const putCall = r2Mock.send.mock.calls.find((c) => c[0] instanceof PutObjectCommand);
    expect(putCall).toBeDefined();
    expect(putCall![0].input.Key).toMatch(/^projects\/proj-1\/cover\/.+\.jpg$/);
    expect(putCall![0].input.ContentType).toBe('image/jpeg');
    const deleteCall = r2Mock.send.mock.calls.find(
      (c) => c[0] instanceof DeleteObjectCommand && c[0].input.Key === 'generations/old-cover.png',
    );
    expect(deleteCall).toBeDefined();
    expect(mockExtractVideoFrame).not.toHaveBeenCalled();
  });

  it('K-B1 multipart: returns 404 for a project owned by another user (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app)
      .post('/api/projects/not-mine/cover')
      .attach('file', Buffer.from('fake-jpg'), { filename: 'cover.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    const putCalls = r2Mock.send.mock.calls.filter((c) => c[0] instanceof PutObjectCommand);
    expect(putCalls).toHaveLength(0);
  });

  it('K-B1 multipart: rejects unsupported mime with 400', async () => {
    const res = await request(app)
      .post('/api/projects/proj-1/cover')
      .attach('file', Buffer.from('fake-pdf'), { filename: 'cover.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('K-B1: JSON clip_id branch still works alongside the multipart middleware', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1', thumbnail_r2_key: null })]))
      .mockReturnValueOnce(
        makeChain([
          { id: 'clip-1', project_id: 'proj-1', r2_key: 'projects/proj-1/clips/a.mp4', media_type: 'video', original_duration_seconds: 10, deleted_at: null },
        ]),
      );
    dbMock.update.mockReturnValueOnce(makeChain(undefined));

    const res = await request(app).post('/api/projects/proj-1/cover').send({ clip_id: 'clip-1', at_seconds: 2 });

    expect(res.status).toBe(200);
    expect(res.body.thumbnail_url).toBe('https://r2.example.com/presigned-clip-url');
    expect(mockExtractVideoFrame).toHaveBeenCalled();
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
        { id: 'clip-2', project_id: 'proj-1', sort_order: 0, r2_key: 'projects/proj-1/clips/upload-uuid.jpg', media_type: 'image', source_type: 'upload', original_duration_seconds: 3, created_at: NOW },
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
    // B1 (13-22): image uploads still get probed (for pixel dimensions — ffprobe reads image
    // dimensions too) but the fixed CapCut-style still duration wins over any probed duration.
    expect(mockProbeVideoMeta).toHaveBeenCalledTimes(1);
    const insertedValues = dbMock.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(insertedValues.original_duration_seconds).toBe(3);
  });

  it('B1: video upload path probes the just-uploaded temp file and passes the real duration + dimensions through', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{ count: 0 }])); // clip count
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 0 }] });
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        { id: 'clip-3', project_id: 'proj-1', sort_order: 0, r2_key: 'projects/proj-1/clips/upload-uuid.mp4', media_type: 'video', source_type: 'upload', original_duration_seconds: 6.24, width: 1080, height: 1920, created_at: NOW },
      ]),
    );
    mockProbeVideoMeta.mockResolvedValueOnce({ durationSeconds: 6.24, width: 1080, height: 1920 });

    const res = await request(app)
      .post('/api/projects/proj-1/clips')
      .attach('file', Buffer.from('fake-mp4-bytes'), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(201);
    expect(mockProbeVideoMeta).toHaveBeenCalledTimes(1);
    // Probed a local temp path (os.tmpdir()), never the raw R2 key or a URL.
    expect(mockProbeVideoMeta.mock.calls[0][0]).toMatch(/clip-probe-.*\.mp4$/);
    const insertedValues = dbMock.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(insertedValues.original_duration_seconds).toBe(6.24);
    expect(insertedValues.width).toBe(1080);
    expect(insertedValues.height).toBe(1920);
  });

  it('B1: video upload path inserts a null duration/dimensions (never fails the import) when the probe fails', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]));
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 0 }] });
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        { id: 'clip-4', project_id: 'proj-1', sort_order: 0, r2_key: 'projects/proj-1/clips/upload-uuid2.mp4', media_type: 'video', source_type: 'upload', original_duration_seconds: null, width: null, height: null, created_at: NOW },
      ]),
    );
    mockProbeVideoMeta.mockResolvedValueOnce({ durationSeconds: null, width: null, height: null }); // simulates a probe failure (mediaProbe never throws)

    const res = await request(app)
      .post('/api/projects/proj-1/clips')
      .attach('file', Buffer.from('fake-mp4-bytes'), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(201);
    const insertedValues = dbMock.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(insertedValues.original_duration_seconds).toBeNull();
    expect(insertedValues.width).toBeNull();
    expect(insertedValues.height).toBeNull();
  });

  it('B1: generation import probes a presigned URL of the newly copied clip and passes the real duration + dimensions through', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{ count: 0 }])) // clip count
      .mockReturnValueOnce(
        makeChain([
          { id: 'gen-2', r2_key: 'generations/gen-2.mp4', status: 'completed', media_type: 'video', params: null, user_id: 'test-db-user-id' },
        ]),
      ) // route's own generation lookup
      .mockReturnValueOnce(
        makeChain([{ r2_key: 'generations/gen-2.mp4', status: 'completed' }]),
      ); // importClipByCopy's internal ownership-scoped lookup
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 0 }] });
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        { id: 'clip-5', project_id: 'proj-1', sort_order: 0, r2_key: 'projects/proj-1/clips/new-uuid2.mp4', media_type: 'video', source_type: 'generation', original_duration_seconds: 9.5, width: 1920, height: 1080, created_at: NOW },
      ]),
    );
    mockProbeVideoMeta.mockResolvedValueOnce({ durationSeconds: 9.5, width: 1920, height: 1080 });

    const res = await request(app)
      .post('/api/projects/proj-1/clips')
      .send({ source_type: 'generation', generation_id: 'gen-2' });

    expect(res.status).toBe(201);
    expect(mockProbeVideoMeta).toHaveBeenCalledWith('https://r2.example.com/presigned-clip-url');
    const insertedValues = dbMock.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(insertedValues.original_duration_seconds).toBe(9.5);
    expect(insertedValues.width).toBe(1920);
    expect(insertedValues.height).toBe(1080);
  });

  it('B1: generation import of an image passes the fixed 3s still duration but IS probed for dimensions', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]))
      .mockReturnValueOnce(
        makeChain([
          { id: 'gen-3', r2_key: 'generations/gen-3.png', status: 'completed', media_type: 'image', params: null, user_id: 'test-db-user-id' },
        ]),
      )
      .mockReturnValueOnce(makeChain([{ r2_key: 'generations/gen-3.png', status: 'completed' }]));
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 0 }] });
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        { id: 'clip-6', project_id: 'proj-1', sort_order: 0, r2_key: 'projects/proj-1/clips/new-uuid3.png', media_type: 'image', source_type: 'generation', original_duration_seconds: 3, width: 1200, height: 1600, created_at: NOW },
      ]),
    );
    mockProbeVideoMeta.mockResolvedValueOnce({ durationSeconds: null, width: 1200, height: 1600 });

    const res = await request(app)
      .post('/api/projects/proj-1/clips')
      .send({ source_type: 'generation', generation_id: 'gen-3' });

    expect(res.status).toBe(201);
    expect(mockProbeVideoMeta).toHaveBeenCalledWith('https://r2.example.com/presigned-clip-url');
    const insertedValues = dbMock.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(insertedValues.original_duration_seconds).toBe(3);
    expect(insertedValues.width).toBe(1200);
    expect(insertedValues.height).toBe(1600);
  });
});

// ─── PATCH /api/projects/:id/clips/:clipId ─────────────────────────────────────

describe('PATCH /api/projects/:id/clips/:clipId', () => {
  it('trims a clip and returns 200', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{
        trim_start_seconds: 0, trim_end_seconds: 10, original_duration_seconds: 10,
      }])) // authoritative current clip
      .mockReturnValueOnce(makeChain([])); // no captions
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'clip-1', project_id: 'proj-1', sort_order: 0, trim_start_seconds: 2, trim_end_seconds: 8 }]),
    );

    const res = await request(app)
      .patch('/api/projects/proj-1/clips/clip-1')
      .send({ trim_start_seconds: 2, trim_end_seconds: 8 });

    expect(res.status).toBe(200);
    expect(res.body.clip.trim_start_seconds).toBe(2);
    expect(res.body).not.toHaveProperty('captions_may_be_stale');
  });

  it('returns captions_may_be_stale when a trim changes on a project with caption cues', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{
        trim_start_seconds: 0, trim_end_seconds: 8, original_duration_seconds: 10,
      }])) // authoritative current clip
      .mockReturnValueOnce(makeChain([{ id: 'cue-1' }])); // project has captions
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'clip-1', project_id: 'proj-1', sort_order: 0, trim_start_seconds: 5, trim_end_seconds: 8 }]),
    );

    const res = await request(app)
      .patch('/api/projects/proj-1/clips/clip-1')
      .send({ trim_start_seconds: 5 });

    expect(res.status).toBe(200);
    expect(res.body.captions_may_be_stale).toBe(true);
  });

  it('omits captions_may_be_stale for an idempotent trim PATCH even when captions exist', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{
        trim_start_seconds: 5, trim_end_seconds: 8, original_duration_seconds: 10,
      }])); // authoritative current clip; cue lookup must never run
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'clip-1', project_id: 'proj-1', sort_order: 0, trim_start_seconds: 5, trim_end_seconds: 8 }]),
    );

    const res = await request(app)
      .patch('/api/projects/proj-1/clips/clip-1')
      .send({ trim_start_seconds: 5 });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('captions_may_be_stale');
    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });

  it('treats a null trim end and an explicit source-duration end as the same visible window', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project
      .mockReturnValueOnce(makeChain([{
        trim_start_seconds: 0, trim_end_seconds: null, original_duration_seconds: 10,
      }])); // captions may exist, but equivalent visibility must skip the cue lookup
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'clip-1', project_id: 'proj-1', sort_order: 0, trim_start_seconds: 0, trim_end_seconds: 10 }]),
    );

    const res = await request(app)
      .patch('/api/projects/proj-1/clips/clip-1')
      .send({ trim_end_seconds: 10 });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('captions_may_be_stale');
    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });

  it('rejects negative, non-finite JSON, reversed, and out-of-source trim bounds', async () => {
    const invalidInputs = [
      { body: { trim_start_seconds: -1 }, needsCurrentClip: false },
      { body: { trim_end_seconds: Number.POSITIVE_INFINITY }, needsCurrentClip: false },
      { body: { trim_start_seconds: 8, trim_end_seconds: 2 }, needsCurrentClip: true },
      { body: { trim_end_seconds: 11 }, needsCurrentClip: true },
    ];

    for (const { body, needsCurrentClip } of invalidInputs) {
      dbMock.select.mockReset();
      dbMock.update.mockReset();
      dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }]));
      if (needsCurrentClip) {
        dbMock.select.mockReturnValueOnce(makeChain([{
          trim_start_seconds: 0, trim_end_seconds: 10, original_duration_seconds: 10,
        }]));
      }

      const res = await request(app).patch('/api/projects/proj-1/clips/clip-1').send(body);

      expect(res.status).toBe(400);
      expect(dbMock.update).not.toHaveBeenCalled();
    }
  });

  it('returns 404 when the project is not owned by the requester', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([])); // ownership lookup empty

    const res = await request(app).patch('/api/projects/not-mine/clips/clip-1').send({ sort_order: 1 });

    expect(res.status).toBe(404);
  });

  // Plan 13-25 L6: sort_order PATCH uses move-semantics resequence (dense 0..n-1).
  function clipRowForResequence(id: string, sort_order: number) {
    return {
      id,
      project_id: 'proj-1',
      sort_order,
      r2_key: `projects/proj-1/clips/${id}.mp4`,
      media_type: 'video',
      source_type: 'upload',
      original_duration_seconds: 10,
      trim_start_seconds: 0,
      trim_end_seconds: null,
      created_at: NOW,
    };
  }

  function expectResequenceUpdates(
    liveClips: Array<{ id: string; sort_order: number }>,
    movedClipId: string,
    requestedSortOrder: number,
  ) {
    const fromIndex = liveClips.findIndex((c) => c.id === movedClipId);
    let toIndex = liveClips.findIndex((c) => c.sort_order === requestedSortOrder);
    if (toIndex < 0) toIndex = liveClips.length;
    const working = [...liveClips];
    const [moved] = working.splice(fromIndex, 1);
    const insertAt = Math.min(toIndex, working.length);
    working.splice(insertAt, 0, moved);
    return working.map((c, i) => ({ id: c.id, sort_order: i }));
  }

  function mockClipResequence(
    liveClips: ReturnType<typeof clipRowForResequence>[],
    movedClipId: string,
    requestedSortOrder: number,
  ) {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // ownership
    dbMock.select.mockReturnValueOnce(makeChain(liveClips)); // resequence select (non-deleted only)
    const finalOrder = expectResequenceUpdates(liveClips, movedClipId, requestedSortOrder);
    for (const { id, sort_order } of finalOrder) {
      const row = liveClips.find((c) => c.id === id)!;
      dbMock.update.mockReturnValueOnce(makeChain([{ ...row, sort_order }]));
    }
    return finalOrder;
  }

  it('L6: move first→last resequences all clips to dense 0..n-1', async () => {
    const live = [
      clipRowForResequence('clip-0', 0),
      clipRowForResequence('clip-1', 1),
      clipRowForResequence('clip-2', 2),
    ];
    const finalOrder = mockClipResequence(live, 'clip-0', 2);

    const res = await request(app)
      .patch('/api/projects/proj-1/clips/clip-0')
      .send({ sort_order: 2 });

    expect(res.status).toBe(200);
    expect(res.body.clip.id).toBe('clip-0');
    expect(res.body.clip.sort_order).toBe(2);
    expect(res.body).not.toHaveProperty('captions_may_be_stale');
    expect(finalOrder).toEqual([
      { id: 'clip-1', sort_order: 0 },
      { id: 'clip-2', sort_order: 1 },
      { id: 'clip-0', sort_order: 2 },
    ]);
    expect(dbMock.update).toHaveBeenCalledTimes(3);
  });

  it('L6: move last→first resequences all clips to dense 0..n-1', async () => {
    const live = [
      clipRowForResequence('clip-0', 0),
      clipRowForResequence('clip-1', 1),
      clipRowForResequence('clip-2', 2),
    ];
    const finalOrder = mockClipResequence(live, 'clip-2', 0);

    const res = await request(app)
      .patch('/api/projects/proj-1/clips/clip-2')
      .send({ sort_order: 0 });

    expect(res.status).toBe(200);
    expect(res.body.clip.sort_order).toBe(0);
    expect(finalOrder).toEqual([
      { id: 'clip-2', sort_order: 0 },
      { id: 'clip-0', sort_order: 1 },
      { id: 'clip-1', sort_order: 2 },
    ]);
  });

  it('L6: move middle→middle resequences to dense order', async () => {
    const live = [
      clipRowForResequence('clip-0', 0),
      clipRowForResequence('clip-1', 1),
      clipRowForResequence('clip-2', 2),
    ];
    const finalOrder = mockClipResequence(live, 'clip-1', 2);

    const res = await request(app)
      .patch('/api/projects/proj-1/clips/clip-1')
      .send({ sort_order: 2 });

    expect(res.status).toBe(200);
    expect(res.body.clip.sort_order).toBe(2);
    expect(finalOrder).toEqual([
      { id: 'clip-0', sort_order: 0 },
      { id: 'clip-2', sort_order: 1 },
      { id: 'clip-1', sort_order: 2 },
    ]);
  });

  it('L6: single-clip sort_order is a no-op resequence', async () => {
    const live = [clipRowForResequence('clip-only', 0)];
    mockClipResequence(live, 'clip-only', 0);

    const res = await request(app)
      .patch('/api/projects/proj-1/clips/clip-only')
      .send({ sort_order: 0 });

    expect(res.status).toBe(200);
    expect(res.body.clip.sort_order).toBe(0);
    expect(dbMock.update).toHaveBeenCalledTimes(1);
  });

  it('L6: soft-deleted clips are excluded from resequence select', async () => {
    // Only non-deleted rows returned by the resequence query — deleted clip keeps its old sort_order.
    const live = [clipRowForResequence('clip-0', 0), clipRowForResequence('clip-1', 1)];
    mockClipResequence(live, 'clip-0', 1);

    const res = await request(app)
      .patch('/api/projects/proj-1/clips/clip-0')
      .send({ sort_order: 1 });

    expect(res.status).toBe(200);
    expect(dbMock.select).toHaveBeenCalledTimes(2);
    expect(dbMock.update).toHaveBeenCalledTimes(2);
  });
});

// ─── DELETE /api/projects/:id/clips/:clipId ────────────────────────────────────

describe('DELETE /api/projects/:id/clips/:clipId', () => {
  it('returns 204, soft-deletes (sets deleted_at) and does NOT touch R2 (Plan 13-21 B1)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // softDeleteClip's isProjectOwned
    dbMock.update.mockReturnValueOnce(makeChain([{ id: 'clip-1' }])); // deleted_at set, isNull(deleted_at) matched

    const res = await request(app).delete('/api/projects/proj-1/clips/clip-1');

    expect(res.status).toBe(204);
    expect(r2Mock.send.mock.calls.find((c) => c[0] instanceof DeleteObjectCommand)).toBeUndefined();
  });

  it('returns 404 when the clip is already soft-deleted or missing', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }]));
    dbMock.update.mockReturnValueOnce(makeChain([])); // isNull(deleted_at) filter excludes it — 0 rows

    const res = await request(app).delete('/api/projects/proj-1/clips/clip-1');

    expect(res.status).toBe(404);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app).delete('/api/projects/not-mine/clips/clip-1');

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/projects/:id/clips/:clipId/restore (Plan 13-21 B1.3) ───────────

describe('POST /api/projects/:id/clips/:clipId/restore', () => {
  it('returns 200 and clears deleted_at on a soft-deleted clip', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // restoreClip's isProjectOwned
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'clip-1', project_id: 'proj-1', deleted_at: null }]),
    );

    const res = await request(app).post('/api/projects/proj-1/clips/clip-1/restore');

    expect(res.status).toBe(200);
    expect(res.body.clip.id).toBe('clip-1');
  });

  it('returns 404 when the clip was never deleted, is missing, or was already purged', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }]));
    dbMock.update.mockReturnValueOnce(makeChain([])); // isNotNull(deleted_at) filter excludes it

    const res = await request(app).post('/api/projects/proj-1/clips/clip-1/restore');

    expect(res.status).toBe(404);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app).post('/api/projects/not-mine/clips/clip-1/restore');

    expect(res.status).toBe(404);
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

  it("B2 (13-22): aspect_ratio 'original' resolves originalCanvasWidth/Height from the FIRST (sort_order) clip's stored dimensions", async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // owned project (route-level check)
      .mockReturnValueOnce(makeChain([{ count: 2 }])) // clip count
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1', aspect_ratio: 'original' })])) // buildComposeSnapshot's project row
      .mockReturnValueOnce(
        makeChain([
          baseClipRow({ id: 'clip-first', sort_order: 0, width: 1920, height: 1080 }),
          baseClipRow({ id: 'clip-second', sort_order: 1, width: 400, height: 400 }),
        ]),
      ) // clips — ordered by sort_order; only the FIRST clip's dims should be used
      .mockReturnValueOnce(makeChain([])) // text overlays
      .mockReturnValueOnce(makeChain([])) // audio clips
      .mockReturnValueOnce(makeChain([])); // caption cues
    mockCreateGeneration.mockResolvedValueOnce({ id: 'gen-export-original' });

    const res = await request(app).post('/api/projects/proj-1/export').send({});

    expect(res.status).toBe(202);
    expect(mockFfmpegQueueAdd).toHaveBeenCalledWith(
      'compose-job',
      expect.objectContaining({
        compose: expect.objectContaining({
          aspectRatio: 'original',
          originalCanvasWidth: 1920,
          originalCanvasHeight: 1080,
        }),
      }),
    );
  });

  it("B2 (13-22): aspect_ratio 'original' with no probed dimensions on the first clip leaves originalCanvasWidth/Height undefined (canvas resolver falls back to 1080x1920)", async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 1 }]))
      .mockReturnValueOnce(makeChain([baseProjectRow({ id: 'proj-1', aspect_ratio: 'original' })]))
      .mockReturnValueOnce(makeChain([baseClipRow({ width: null, height: null })]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]));
    mockCreateGeneration.mockResolvedValueOnce({ id: 'gen-export-original-2' });

    const res = await request(app).post('/api/projects/proj-1/export').send({});

    expect(res.status).toBe(202);
    const call = mockFfmpegQueueAdd.mock.calls.find((c) => c[0] === 'compose-job');
    expect(call![1].compose.aspectRatio).toBe('original');
    expect(call![1].compose.originalCanvasWidth).toBeUndefined();
    expect(call![1].compose.originalCanvasHeight).toBeUndefined();
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

  it('rejects an out-of-range row_index (400) with 400 and never touches the db (Plan 13-26 M8-backend)', async () => {
    const res = await request(app)
      .post('/api/projects/proj-1/text')
      .send({ text: 'Hi', x_norm: 0.5, y_norm: 0.5, row_index: 51, start_seconds: 0, end_seconds: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/row_index must be an integer between 0 and 50/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('rejects a non-integer row_index (400) with 400 and never touches the db (Plan 13-26 M8-backend)', async () => {
    const res = await request(app)
      .post('/api/projects/proj-1/text')
      .send({ text: 'Hi', x_norm: 0.5, y_norm: 0.5, row_index: 1.5, start_seconds: 0, end_seconds: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/row_index must be an integer between 0 and 50/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('accepts a row_index within 0..50 and threads it through to addTextOverlay (Plan 13-26 M8-backend)', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]))
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]));
    dbMock.insert.mockReturnValueOnce(
      makeChain([
        {
          id: 'text-row',
          project_id: 'proj-1',
          text: 'Hi',
          x_norm: 0.5,
          y_norm: 0.5,
          width_norm: 1,
          rotation: 0,
          row_index: 2,
          start_seconds: 0,
          end_seconds: 2,
          created_at: NOW,
        },
      ]),
    );

    const res = await request(app)
      .post('/api/projects/proj-1/text')
      .send({ text: 'Hi', x_norm: 0.5, y_norm: 0.5, row_index: 2, start_seconds: 0, end_seconds: 2 });

    expect(res.status).toBe(201);
    expect(res.body.text_overlay.row_index).toBe(2);
    expect(dbMock.insert).toHaveBeenCalled();
    const insertedValues = dbMock.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(insertedValues.row_index).toBe(2);
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

  it('rejects an out-of-range row_index with 400 (Plan 13-26 M8-backend)', async () => {
    const res = await request(app).patch('/api/projects/proj-1/text/text-1').send({ row_index: 100 });

    expect(res.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('rejects a negative row_index with 400 (Plan 13-26 M8-backend)', async () => {
    const res = await request(app).patch('/api/projects/proj-1/text/text-1').send({ row_index: -1 });

    expect(res.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('updates row_index and returns 200 (Plan 13-26 M8-backend)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // isProjectOwned
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'text-1', project_id: 'proj-1', text: 'Hi', row_index: 3 }]),
    );

    const res = await request(app).patch('/api/projects/proj-1/text/text-1').send({ row_index: 3 });

    expect(res.status).toBe(200);
    expect(res.body.text_overlay.row_index).toBe(3);
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

  it('B2: probes the uploaded file duration and persists it on the new row', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]))
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }]));
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 0 }] });
    mockProbeDurationSeconds.mockResolvedValueOnce(12.5);
    const valuesFn = jest.fn().mockReturnValue(
      makeChain([
        {
          id: 'audio-3',
          project_id: 'proj-1',
          r2_key: 'projects/proj-1/audio/new.mp3',
          source_type: 'upload',
          start_offset_seconds: 0,
          trim_start_seconds: 0,
          trim_end_seconds: null,
          original_duration_seconds: 12.5,
          sort_order: 0,
          created_at: NOW,
        },
      ]),
    );
    dbMock.insert.mockReturnValueOnce({ values: valuesFn });

    const res = await request(app)
      .post('/api/projects/proj-1/audio')
      .attach('file', Buffer.from('fake-mp3'), { filename: 'a.mp3', contentType: 'audio/mpeg' });

    expect(res.status).toBe(201);
    expect(mockProbeDurationSeconds).toHaveBeenCalled();
    expect(res.body.audio_clip.original_duration_seconds).toBe(12.5);
    expect(valuesFn.mock.calls[0][0]).toMatchObject({ original_duration_seconds: 12.5 });
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
  it('returns 204, soft-deletes (sets deleted_at) and does NOT touch R2 (Plan 13-21 B1)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // deleteAudioClip's isProjectOwned
    dbMock.update.mockReturnValueOnce(makeChain([{ id: 'audio-1' }]));

    const res = await request(app).delete('/api/projects/proj-1/audio/audio-1');

    expect(res.status).toBe(204);
    expect(r2Mock.send.mock.calls.find((c) => c[0] instanceof DeleteObjectCommand)).toBeUndefined();
  });

  it('returns 404 when the audio clip is already soft-deleted or missing', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }]));
    dbMock.update.mockReturnValueOnce(makeChain([]));

    const res = await request(app).delete('/api/projects/proj-1/audio/audio-1');

    expect(res.status).toBe(404);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app).delete('/api/projects/not-mine/audio/audio-1');

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/projects/:id/audio/:audioId/restore (Plan 13-21 B1.3) ──────────

describe('POST /api/projects/:id/audio/:audioId/restore', () => {
  it('returns 200 and clears deleted_at on a soft-deleted audio clip', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // restoreAudioClip's isProjectOwned
    dbMock.update.mockReturnValueOnce(
      makeChain([{ id: 'audio-1', project_id: 'proj-1', deleted_at: null }]),
    );

    const res = await request(app).post('/api/projects/proj-1/audio/audio-1/restore');

    expect(res.status).toBe(200);
    expect(res.body.audio_clip.id).toBe('audio-1');
  });

  it('returns 404 when the audio clip was never deleted, is missing, or was already purged', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{ id: 'proj-1' }]));
    dbMock.update.mockReturnValueOnce(makeChain([]));

    const res = await request(app).post('/api/projects/proj-1/audio/audio-1/restore');

    expect(res.status).toBe(404);
  });

  it('returns 404 when the project is not owned by the requester (IDOR)', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(app).post('/api/projects/not-mine/audio/audio-1/restore');

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
      .mockReturnValueOnce(makeChain([{
        id: 'clip-1', r2_key: 'projects/proj-1/clips/a.mp4', trim_start_seconds: 0,
        trim_end_seconds: 5, original_duration_seconds: 5,
      }])) // ordered clip lookup
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
      .mockReturnValueOnce(makeChain([{
        id: 'clip-1', r2_key: 'projects/proj-1/clips/a.mp4', trim_start_seconds: 0,
        trim_end_seconds: 5, original_duration_seconds: 5,
      }])); // ordered clip lookup
    mockTranscribeToWordCues.mockRejectedValueOnce(new TranscriptionError('OpenAI transcription failed (500): boom'));

    const res = await request(app).post('/api/projects/proj-1/clips/clip-1/captions/auto-generate');

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Transcription failed');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('maps a trimmed second clip through the route before persisting cues and words', async () => {
    const orderedClipsChain = makeChain([
      {
        id: 'clip-1', r2_key: 'projects/proj-1/clips/first.mp4', trim_start_seconds: 1,
        trim_end_seconds: 4, original_duration_seconds: 8,
      },
      {
        id: 'clip-2', r2_key: 'projects/proj-1/clips/second.mp4', trim_start_seconds: 5,
        trim_end_seconds: 9, original_duration_seconds: 10,
      },
    ]);
    dbMock.select
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])) // route ownership
      .mockReturnValueOnce(orderedClipsChain) // authoritative ordered, non-deleted clips
      .mockReturnValueOnce(makeChain([{ id: 'proj-1' }])); // addCaptionCue ownership
    mockTranscribeToWordCues.mockResolvedValueOnce([{
      startSeconds: 2,
      endSeconds: 6,
      words: [
        { text: 'cut', startSeconds: 2, endSeconds: 3 },
        { text: 'kept', startSeconds: 5.5, endSeconds: 6 },
      ],
    }]);
    dbMock.execute.mockResolvedValueOnce({ rows: [{ next_order: 0 }] });
    const cueInsertChain = makeChain([{
      id: 'cue-route', project_id: 'proj-1', sort_order: 0, start_seconds: 3.5, end_seconds: 4,
      created_at: NOW,
    }]);
    const wordInsertChain = makeChain([{
      id: 'word-route', cue_id: 'cue-route', text: 'kept', start_seconds: 3.5,
      end_seconds: 4, sort_order: 0,
    }]);
    dbMock.insert.mockReturnValueOnce(cueInsertChain).mockReturnValueOnce(wordInsertChain);

    const res = await request(app).post('/api/projects/proj-1/clips/clip-2/captions/auto-generate');

    expect(res.status).toBe(200);
    expect(mockTranscribeToWordCues).toHaveBeenCalledWith('projects/proj-1/clips/second.mp4');
    expect(cueInsertChain.values).toHaveBeenCalledWith(expect.objectContaining({
      start_seconds: 3.5,
      end_seconds: 4,
    }));
    expect(wordInsertChain.values).toHaveBeenCalledWith([expect.objectContaining({
      text: 'kept',
      start_seconds: 3.5,
      end_seconds: 4,
    })]);
    expect(wordInsertChain.values).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ text: 'cut' })]),
    );
    expect(res.body.cues[0].words).toEqual([expect.objectContaining({ text: 'kept' })]);
    const sqlNodeHasClause = (value: unknown, column: unknown, suffix: string, seen = new Set<unknown>()): boolean => {
      if (value === null || typeof value !== 'object' || seen.has(value)) return false;
      seen.add(value);
      const record = value as Record<string, unknown>;
      const chunks = record.queryChunks;
      if (Array.isArray(chunks)) {
        const hasColumn = chunks.some((chunk) => chunk === column);
        const hasSuffix = chunks.some((chunk) => {
          if (chunk === null || typeof chunk !== 'object') return false;
          const chunkValue = (chunk as { value?: unknown }).value;
          return Array.isArray(chunkValue) && chunkValue.includes(suffix);
        });
        if (hasColumn && hasSuffix) return true;
      }
      return Object.values(record).some((child) => sqlNodeHasClause(child, column, suffix, seen));
    };
    const orderArgs = orderedClipsChain.orderBy.mock.calls[0];
    expect(sqlNodeHasClause(orderArgs[0], projectClips.sort_order, ' asc')).toBe(true);
    expect(sqlNodeHasClause(orderArgs[1], projectClips.created_at, ' asc')).toBe(true);
    expect(sqlNodeHasClause(orderedClipsChain.where.mock.calls[0][0], projectClips.deleted_at, ' is null')).toBe(true);
  });

  it('maps a word at source trimStart=5 to the target clip timeline start', () => {
    const translated = translateCaptionDraftsToProjectTimeline(
      [{ startSeconds: 5, endSeconds: 5.5, words: [{ text: 'hello', startSeconds: 5, endSeconds: 5.5 }] }],
      [{ id: 'clip-a', trimStartSeconds: 5, trimEndSeconds: 10, originalDurationSeconds: 10 }],
      'clip-a',
    );

    expect(translated[0].words?.[0]).toEqual({ text: 'hello', startSeconds: 0, endSeconds: 0.5 });
    expect(translated[0].startSeconds).toBe(0);
  });

  it('drops a word wholly inside the trimmed-away beginning', () => {
    const translated = translateCaptionDraftsToProjectTimeline(
      [{ startSeconds: 2, endSeconds: 3, words: [{ text: 'cut', startSeconds: 2, endSeconds: 3 }] }],
      [{ id: 'clip-a', trimStartSeconds: 5, trimEndSeconds: 10, originalDurationSeconds: 10 }],
      'clip-a',
    );

    expect(translated).toEqual([]);
  });

  it("offsets a second clip's words by the first clip's trimmed duration", () => {
    const translated = translateCaptionDraftsToProjectTimeline(
      [{ startSeconds: 2, endSeconds: 2.5, words: [{ text: 'second', startSeconds: 2, endSeconds: 2.5 }] }],
      [
        { id: 'clip-a', trimStartSeconds: 1, trimEndSeconds: 4, originalDurationSeconds: 8 },
        { id: 'clip-b', trimStartSeconds: 2, trimEndSeconds: 7, originalDurationSeconds: 9 },
      ],
      'clip-b',
    );

    expect(translated[0].words?.[0]).toEqual({ text: 'second', startSeconds: 3, endSeconds: 3.5 });
  });

  it('leaves an untrimmed single clip unchanged', () => {
    const translated = translateCaptionDraftsToProjectTimeline(
      [{ startSeconds: 1, endSeconds: 2, words: [{ text: 'same', startSeconds: 1, endSeconds: 2 }] }],
      [{ id: 'clip-a', trimStartSeconds: 0, trimEndSeconds: null, originalDurationSeconds: 10 }],
      'clip-a',
    );

    expect(translated).toEqual([
      { startSeconds: 1, endSeconds: 2, words: [{ text: 'same', startSeconds: 1, endSeconds: 2 }] },
    ]);
  });

  it('clamps boundary-overlapping words and derives cue bounds from mapped words', () => {
    const translated = translateCaptionDraftsToProjectTimeline(
      [{
        startSeconds: 1.5,
        endSeconds: 8.5,
        words: [
          { text: 'before', startSeconds: 1.5, endSeconds: 1.9 },
          { text: 'hello', startSeconds: 2.5, endSeconds: 3.0 },
          { text: 'edge', startSeconds: 7.8, endSeconds: 8.4 },
          { text: 'after', startSeconds: 8.5, endSeconds: 9.0 },
        ],
      }],
      [
        { id: 'clip-b', trimStartSeconds: 0, trimEndSeconds: 4, originalDurationSeconds: 4 },
        { id: 'clip-a', trimStartSeconds: 2, trimEndSeconds: 8, originalDurationSeconds: 10 },
      ],
      'clip-a',
    );

    expect(translated).toEqual([{
      startSeconds: 4.5,
      endSeconds: 10,
      words: [
        { text: 'hello', startSeconds: 4.5, endSeconds: 5 },
        { text: 'edge', startSeconds: 9.8, endSeconds: 10 },
      ],
    }]);
  });

  it('normalizes source bounds and drops reversed, null-duration, and non-finite inputs safely', () => {
    const normalized = translateCaptionDraftsToProjectTimeline(
      [{
        startSeconds: -2,
        endSeconds: 20,
        words: [
          { text: 'left', startSeconds: -2, endSeconds: 1 },
          { text: 'right', startSeconds: 9, endSeconds: 20 },
          { text: 'nan', startSeconds: Number.NaN, endSeconds: 3 },
          { text: 'infinite', startSeconds: 3, endSeconds: Number.POSITIVE_INFINITY },
        ],
      }],
      [
        { id: 'bad-predecessor', trimStartSeconds: 0, trimEndSeconds: Number.POSITIVE_INFINITY, originalDurationSeconds: null },
        { id: 'target', trimStartSeconds: -5, trimEndSeconds: 20, originalDurationSeconds: 10 },
      ],
      'target',
    );

    expect(normalized).toEqual([{
      startSeconds: 0,
      endSeconds: 10,
      words: [
        { text: 'left', startSeconds: 0, endSeconds: 1 },
        { text: 'right', startSeconds: 9, endSeconds: 10 },
      ],
    }]);
    expect(JSON.stringify(normalized)).not.toMatch(/NaN|Infinity/);

    expect(translateCaptionDraftsToProjectTimeline(
      [{ startSeconds: 0, endSeconds: 1, words: [{ text: 'x', startSeconds: 0, endSeconds: 1 }] }],
      [{ id: 'target', trimStartSeconds: 5, trimEndSeconds: 2, originalDurationSeconds: 10 }],
      'target',
    )).toEqual([]);
    expect(translateCaptionDraftsToProjectTimeline(
      [{ startSeconds: 0, endSeconds: 1, words: [{ text: 'x', startSeconds: 0, endSeconds: 1 }] }],
      [{ id: 'target', trimStartSeconds: 0, trimEndSeconds: null, originalDurationSeconds: null }],
      'target',
    )).toEqual([]);
    expect(translateCaptionDraftsToProjectTimeline(
      [{ startSeconds: 0, endSeconds: 1, words: [{ text: 'x', startSeconds: 0, endSeconds: 1 }] }],
      [{ id: 'target', trimStartSeconds: Number.NaN, trimEndSeconds: 2, originalDurationSeconds: 10 }],
      'target',
    )).toEqual([]);
    expect(translateCaptionDraftsToProjectTimeline(
      [{ startSeconds: 0, endSeconds: 1, words: [{ text: 'x', startSeconds: 0, endSeconds: 1 }] }],
      [{ id: 'target', trimStartSeconds: 0, trimEndSeconds: 2, originalDurationSeconds: Number.POSITIVE_INFINITY }],
      'target',
    )).toEqual([]);
  });

  it('fails closed when individually finite predecessor durations overflow their timeline sum', () => {
    const translated = translateCaptionDraftsToProjectTimeline(
      [{ startSeconds: 0, endSeconds: 1, words: [{ text: 'target', startSeconds: 0, endSeconds: 1 }] }],
      [
        { id: 'huge-1', trimStartSeconds: 0, trimEndSeconds: Number.MAX_VALUE, originalDurationSeconds: null },
        { id: 'huge-2', trimStartSeconds: 0, trimEndSeconds: Number.MAX_VALUE, originalDurationSeconds: null },
        { id: 'target', trimStartSeconds: 0, trimEndSeconds: 1, originalDurationSeconds: 1 },
      ],
      'target',
    );

    expect(translated).toEqual([]);
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
