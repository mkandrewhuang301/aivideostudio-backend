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

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { CopyObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { projectsRouter } from '../../routes/projects';
import { smartUnpackOnImport } from '../../services/projectService';
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
