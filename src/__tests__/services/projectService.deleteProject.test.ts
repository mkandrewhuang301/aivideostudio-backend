// src/__tests__/services/projectService.deleteProject.test.ts
// Unit tests for projectService.deleteProject — FK-safe delete ordering across the audio tables
// (AI music, voiceover, separation) and complete R2 key collection so deleting a project leaves
// no orphaned objects paying rent in the bucket.
//
// The regression these pin: soundtrack/voiceover/separation rows FK to projects (and to
// project_clips) WITHOUT cascade, so deleting project_clips or projects before them raises a FK
// violation; and a separation job that produced stems but never attached them owns R2 objects no
// project_audio_clips row points at, so collecting only audio-clip keys leaks them.
//
// All DB/R2 calls are mocked: no live Neon/R2 connection required.

const mockSelect = jest.fn();
const mockDelete = jest.fn();
const mockExecute = jest.fn();
jest.mock('../../db/client', () => ({
  db: {
    select: mockSelect,
    delete: mockDelete,
    execute: mockExecute,
    insert: jest.fn(),
    update: jest.fn(),
    batch: jest.fn(),
  },
}));

const mockR2Send = jest.fn();
jest.mock('../../storage/r2', () => ({
  r2: { send: mockR2Send },
  R2_BUCKET: 'test-bucket',
}));

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  audioSeparationJobs,
  projectAudioClips,
  projectCaptionCues,
  projectCaptionWords,
  projectClips,
  projectMusicSuggestionCache,
  projects,
  projectSoundtrackGenerations,
  projectTextOverlays,
  projectVoiceoverGenerations,
} from '../../db/schema';
import { deleteProject } from '../../services/projectService';

const PROJECT_ID = 'project-1';
const USER_ID = 'user-1';

const tableNames = new Map<unknown, string>([
  [projectCaptionWords, 'project_caption_words'],
  [projectCaptionCues, 'project_caption_cues'],
  [projectMusicSuggestionCache, 'project_music_suggestion_cache'],
  [projectVoiceoverGenerations, 'project_voiceover_generations'],
  [projectAudioClips, 'project_audio_clips'],
  [audioSeparationJobs, 'audio_separation_jobs'],
  [projectSoundtrackGenerations, 'project_soundtrack_generations'],
  [projectTextOverlays, 'project_text_overlays'],
  [projectClips, 'project_clips'],
  [projects, 'projects'],
]);

/**
 * deleteProject issues its reads as one Promise.all of six builder chains, in a fixed order:
 * project row, then clips / audio clips / caption cues / soundtracks / voiceovers / separations.
 * Queue the rows each chain should resolve to in that same order.
 */
function wireSelects(rowSets: unknown[][]) {
  let call = 0;
  mockSelect.mockImplementation(() => {
    const rows = rowSets[call] ?? [];
    call += 1;
    const chain: Record<string, jest.Mock> = {};
    chain.from = jest.fn().mockReturnValue(chain);
    chain.where = jest.fn().mockResolvedValue(rows);
    return chain;
  });
}

function deletedTablesInOrder(): string[] {
  return mockDelete.mock.calls.map(([table]) => tableNames.get(table) ?? 'unknown');
}

function deletedR2Keys(): string[] {
  return mockR2Send.mock.calls.map(([command]) => (command as DeleteObjectCommand).input.Key as string);
}

const PROJECT_ROW = [{ id: PROJECT_ID, thumbnail_r2_key: 'projects/p1/thumb.jpg' }];

// A fully-populated project: every audio table has a row, and the separation job's stem keys
// match the two audio clips it attached (the overlap case).
function fullProjectRowSets(): unknown[][] {
  return [
    PROJECT_ROW,
    [{ r2_key: 'projects/p1/clips/a.mp4' }, { r2_key: 'projects/p1/clips/b.mp4' }],
    [{ r2_key: 'projects/p1/sep/target.mp3' }, { r2_key: 'projects/p1/sep/residual.mp3' }],
    [{ id: 'cue-1' }, { id: 'cue-2' }],
    [{ raw_r2_key: 'projects/p1/music/raw.wav', final_r2_key: 'projects/p1/music/final.m4a' }],
    [{ raw_r2_key: 'projects/p1/vo/raw.wav', final_r2_key: 'projects/p1/vo/final.m4a' }],
    [{ id: 'job-1', target_r2_key: 'projects/p1/sep/target.mp3', residual_r2_key: 'projects/p1/sep/residual.mp3' }],
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExecute.mockResolvedValue({ rows: [] });
  mockR2Send.mockResolvedValue({});
  mockDelete.mockImplementation((table: unknown) => ({
    where: jest.fn().mockResolvedValue({ tableName: tableNames.get(table) }),
  }));
});

describe('deleteProject — ownership', () => {
  it('returns false and touches nothing when the project is not owned by the caller', async () => {
    wireSelects([[]]);

    await expect(deleteProject(PROJECT_ID, USER_ID)).resolves.toBe(false);

    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockR2Send).not.toHaveBeenCalled();
  });
});

describe('deleteProject — FK-safe delete ordering', () => {
  it('deletes every audio-side table before project_clips and projects', async () => {
    wireSelects(fullProjectRowSets());

    await expect(deleteProject(PROJECT_ID, USER_ID)).resolves.toBe(true);

    const order = deletedTablesInOrder();
    const at = (name: string) => order.indexOf(name);

    // These three FK to projects (and clips) without cascade — all must precede the parents.
    for (const child of [
      'project_music_suggestion_cache',
      'project_voiceover_generations',
      'project_soundtrack_generations',
      'audio_separation_jobs',
    ]) {
      expect(at(child)).toBeGreaterThanOrEqual(0);
      expect(at(child)).toBeLessThan(at('project_clips'));
      expect(at(child)).toBeLessThan(at('projects'));
    }
    // projects is always last.
    expect(at('projects')).toBe(order.length - 1);
  });

  it('clears project_audio_clips BEFORE audio_separation_jobs (stems FK to their job)', async () => {
    wireSelects(fullProjectRowSets());

    await deleteProject(PROJECT_ID, USER_ID);

    const order = deletedTablesInOrder();
    expect(order.indexOf('project_audio_clips')).toBeLessThan(order.indexOf('audio_separation_jobs'));
  });

  it('clears caption words before caption cues (words FK to cue_id)', async () => {
    wireSelects(fullProjectRowSets());

    await deleteProject(PROJECT_ID, USER_ID);

    const order = deletedTablesInOrder();
    expect(order.indexOf('project_caption_words')).toBeLessThan(order.indexOf('project_caption_cues'));
  });

  it('skips the caption-words delete entirely when the project has no cues', async () => {
    const rowSets = fullProjectRowSets();
    rowSets[3] = []; // no caption cues
    wireSelects(rowSets);

    await deleteProject(PROJECT_ID, USER_ID);

    expect(deletedTablesInOrder()).not.toContain('project_caption_words');
  });
});

describe('deleteProject — R2 key collection', () => {
  it('deletes clip, audio, thumbnail, AI music and voiceover objects', async () => {
    wireSelects(fullProjectRowSets());

    await deleteProject(PROJECT_ID, USER_ID);

    expect(deletedR2Keys()).toEqual(expect.arrayContaining([
      'projects/p1/clips/a.mp4',
      'projects/p1/clips/b.mp4',
      'projects/p1/sep/target.mp3',
      'projects/p1/sep/residual.mp3',
      'projects/p1/music/raw.wav',
      'projects/p1/music/final.m4a',
      'projects/p1/vo/raw.wav',
      'projects/p1/vo/final.m4a',
      'projects/p1/thumb.jpg',
    ]));
  });

  it('collects stem keys from a job whose stems were never attached (no audio-clip row points at them)', async () => {
    const rowSets = fullProjectRowSets();
    rowSets[2] = []; // separation completed but attach never ran — zero audio clips
    wireSelects(rowSets);

    await deleteProject(PROJECT_ID, USER_ID);

    // Without the audio_separation_jobs key scan these two objects would leak forever.
    expect(deletedR2Keys()).toEqual(expect.arrayContaining([
      'projects/p1/sep/target.mp3',
      'projects/p1/sep/residual.mp3',
    ]));
  });

  it('dedupes overlapping keys so an attached stem is not deleted twice', async () => {
    wireSelects(fullProjectRowSets());

    await deleteProject(PROJECT_ID, USER_ID);

    const keys = deletedR2Keys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k === 'projects/p1/sep/target.mp3')).toHaveLength(1);
  });

  it('ignores null r2 keys from rows whose media never materialized', async () => {
    const rowSets = fullProjectRowSets();
    rowSets[4] = [{ raw_r2_key: 'projects/p1/music/raw.wav', final_r2_key: null }];
    rowSets[5] = [{ raw_r2_key: null, final_r2_key: null }];
    rowSets[6] = [{ target_r2_key: null, residual_r2_key: null }];
    wireSelects(rowSets);

    await deleteProject(PROJECT_ID, USER_ID);

    const keys = deletedR2Keys();
    expect(keys).toContain('projects/p1/music/raw.wav');
    expect(keys.some((k) => k === null || k === undefined || k === '')).toBe(false);
  });

  it('omits the thumbnail key when the project never got one', async () => {
    const rowSets = fullProjectRowSets();
    rowSets[0] = [{ id: PROJECT_ID, thumbnail_r2_key: null }];
    wireSelects(rowSets);

    await deleteProject(PROJECT_ID, USER_ID);

    expect(deletedR2Keys()).not.toContain('projects/p1/thumb.jpg');
  });

  it("deletes each job's source-input.mp3, whose key lives in no DB column", async () => {
    wireSelects(fullProjectRowSets());

    await deleteProject(PROJECT_ID, USER_ID);

    // Reconstructed from the job id — the only way to reach it, since the worker writes it to a
    // deterministic key and stores that key nowhere.
    expect(deletedR2Keys()).toContain('audio-separation/job-1/source-input.mp3');
  });

  it('breaks the job<->stem FK cycle before deleting either table', async () => {
    wireSelects(fullProjectRowSets());

    await deleteProject(PROJECT_ID, USER_ID);

    const clearEdge = mockExecute.mock.calls.find(([q]) =>
      JSON.stringify(q ?? '').includes('source_audio_clip_id'));
    expect(clearEdge).toBeDefined();

    // audio_separation_jobs.source_audio_clip_id -> project_audio_clips and
    // project_audio_clips.separation_job_id -> audio_separation_jobs form a cycle; clearing the
    // job->stem edge must happen before either DELETE or both are blocked.
    const clearOrder = mockExecute.mock.invocationCallOrder[mockExecute.mock.calls.indexOf(clearEdge!)];
    const audioDeleteIdx = deletedTablesInOrder().indexOf('project_audio_clips');
    const jobsDeleteIdx = deletedTablesInOrder().indexOf('audio_separation_jobs');
    expect(clearOrder).toBeLessThan(mockDelete.mock.invocationCallOrder[audioDeleteIdx]);
    expect(clearOrder).toBeLessThan(mockDelete.mock.invocationCallOrder[jobsDeleteIdx]);
  });

  it('still reports success when an R2 delete fails (DB rows are already gone — never strand the project)', async () => {
    wireSelects(fullProjectRowSets());
    mockR2Send.mockRejectedValue(new Error('R2 unavailable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(deleteProject(PROJECT_ID, USER_ID)).resolves.toBe(true);
    expect(errorSpy).toHaveBeenCalled(); // the leak is logged, not swallowed silently

    errorSpy.mockRestore();
  });
});
