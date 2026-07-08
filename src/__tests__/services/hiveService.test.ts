// src/__tests__/services/hiveService.test.ts
// Unit tests for hiveService — CSAM scanning via Hive v3 Visual Moderation API.
// Covers: flagged/clean single-frame, threshold edge cases, multi-frame, HTTP errors.
// Also covers markQuarantined atomic status transition in generationService.

// Mock config FIRST — config.ts calls requireEnv() at module eval time
jest.mock('../../config', () => ({
  config: { hiveApiKey: 'test-hive-key', hiveInputNsfwThreshold: 0.85 },
}));

// Mock DB for markQuarantined tests
jest.mock('../../db/client', () => ({
  db: {
    execute: jest.fn(),
  },
}));

// Mock R2 storage and presigner — hiveService generates a presigned URL before scanning
jest.mock('../../storage/r2', () => ({
  r2: {},
  R2_BUCKET: 'test-bucket',
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://r2.example.com/video.mp4'),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: jest.fn().mockImplementation((input) => input),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { scanForCsam, scanInputMedia } from '../../services/hiveService';
import { markQuarantined } from '../../services/generationService';
import { db } from '../../db/client';

const mockDb = db as jest.Mocked<typeof db>;

function makeHiveResponse(frames: Array<{ class_name: string; value: number }[]>) {
  return {
    ok: true,
    json: async () => ({
      task_id: 'test-task',
      model: 'hive/visual-moderation',
      output: frames.map((classes) => ({ extra: [], classes })),
    }),
  };
}

describe('scanForCsam', () => {
  beforeEach(() => mockFetch.mockReset());

  it('returns flagged=true when a frame has yes_child_present >= 0.92 AND yes_female_nudity >= 0.85', async () => {
    mockFetch.mockResolvedValue(makeHiveResponse([[
      { class_name: 'yes_child_present', value: 0.95 },
      { class_name: 'yes_female_nudity', value: 0.92 },
    ]]));
    const result = await scanForCsam('https://r2.example.com/video.mp4');
    expect(result.flagged).toBe(true);
  });

  it('returns flagged=false when child_present is high but no explicit sexual content (general_nsfw alone does not flag)', async () => {
    mockFetch.mockResolvedValue(makeHiveResponse([[
      { class_name: 'yes_child_present', value: 0.95 },
      { class_name: 'general_nsfw', value: 0.99 },
    ]]));
    const result = await scanForCsam('https://r2.example.com/video.mp4');
    expect(result.flagged).toBe(false);
  });

  it('returns flagged=false when sexual content is high but no child present', async () => {
    mockFetch.mockResolvedValue(makeHiveResponse([[
      { class_name: 'yes_child_present', value: 0.1 },
      { class_name: 'general_nsfw', value: 0.99 },
    ]]));
    const result = await scanForCsam('https://r2.example.com/video.mp4');
    expect(result.flagged).toBe(false);
  });

  it('returns flagged=false when yes_child_present is below threshold (0.91)', async () => {
    mockFetch.mockResolvedValue(makeHiveResponse([[
      { class_name: 'yes_child_present', value: 0.91 },
      { class_name: 'yes_female_nudity', value: 0.99 },
    ]]));
    const result = await scanForCsam('https://r2.example.com/video.mp4');
    expect(result.flagged).toBe(false);
  });

  it('throws an error when Hive API returns HTTP 500', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(scanForCsam('https://r2.example.com/video.mp4')).rejects.toThrow('Hive API error: 500');
  });

  it('throws when Hive returns empty output array — fails safe rather than delivering unscanned content', async () => {
    mockFetch.mockResolvedValue(makeHiveResponse([]));
    await expect(scanForCsam('video.mp4')).rejects.toThrow('Hive returned empty output');
  });

  it('flags video if ANY frame triggers both conditions (multi-frame video)', async () => {
    mockFetch.mockResolvedValue(makeHiveResponse([
      // Frame 0: clean
      [{ class_name: 'yes_child_present', value: 0.1 }, { class_name: 'general_nsfw', value: 0.1 }],
      // Frame 1: flagged
      [{ class_name: 'yes_child_present', value: 0.93 }, { class_name: 'yes_female_nudity', value: 0.9 }],
    ]));
    const result = await scanForCsam('https://r2.example.com/video.mp4');
    expect(result.flagged).toBe(true);
  });
});

describe('scanInputMedia', () => {
  beforeEach(() => mockFetch.mockReset());

  it('returns { blocked: true, reason: "nsfw" } when a sexual/nudity class exceeds the input NSFW threshold', async () => {
    mockFetch.mockResolvedValue(makeHiveResponse([[
      { class_name: 'yes_female_nudity', value: 0.9 },
    ]]));
    const result = await scanInputMedia('https://r2.example.com/face.jpg');
    expect(result).toEqual({ blocked: true, reason: 'nsfw' });
  });

  it('returns { blocked: false } for a clean face (no sexual/nudity classes over threshold)', async () => {
    mockFetch.mockResolvedValue(makeHiveResponse([[
      { class_name: 'yes_female_nudity', value: 0.1 },
      { class_name: 'general_nsfw', value: 0.2 },
    ]]));
    const result = await scanInputMedia('https://r2.example.com/face.jpg');
    expect(result).toEqual({ blocked: false });
  });

  it('throws (fail-safe) on Hive HTTP error rather than treating input as clean', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(scanInputMedia('https://r2.example.com/face.jpg')).rejects.toThrow('Hive API error: 500');
  });

  it('throws (fail-safe) when Hive returns empty output rather than treating input as clean', async () => {
    mockFetch.mockResolvedValue(makeHiveResponse([]));
    await expect(scanInputMedia('https://r2.example.com/face.jpg')).rejects.toThrow('Hive returned empty output');
  });
});

describe('markQuarantined', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true when db returns a row (generation was quarantined)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValue({ rows: [{ id: 'gen-uuid-1' }] });
    const result = await markQuarantined('gen-uuid-1');
    expect(result).toBe(true);
  });

  it('returns false when db returns no rows (already terminal — idempotent)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValue({ rows: [] });
    const result = await markQuarantined('gen-uuid-2');
    expect(result).toBe(false);
  });
});
