// src/__tests__/services/mediaProbe.test.ts
// Unit tests for probeVideoMeta/probeDurationSeconds (Plan 13-20 Task B1/B3, extended by Plan
// 13-22 Task B1/B3) — mocks child_process.execFile so no real ffprobe binary is invoked. Contract
// under test: happy path parses the ffprobe JSON output (duration + width/height), rotation
// metadata (both the legacy `rotate` tag and the modern displaymatrix `side_data_list` field)
// swaps width/height for a ±90° turn, and EVERY failure mode (garbage output, non-zero exit /
// execFile error) resolves to all-null fields rather than throwing — callers (route + self-heal
// path) rely on this to never fail an import.

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { probeVideoMeta, probeDurationSeconds } from '../../services/mediaProbe';

function mockExecFileOnce(impl: (cb: (err: unknown, result: { stdout: string; stderr: string }) => void) => void) {
  mockExecFile.mockImplementationOnce((_file: string, _args: string[], cb: (err: unknown, result: { stdout: string; stderr: string }) => void) => {
    impl(cb);
  });
}

function ffprobeJson(overrides: {
  stream?: Record<string, unknown> | null;
  formatDuration?: string;
}) {
  const streams = overrides.stream === null ? [] : [{ width: 1080, height: 1920, duration: '9.541000', ...overrides.stream }];
  return JSON.stringify({
    streams,
    format: overrides.formatDuration !== undefined ? { duration: overrides.formatDuration } : {},
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('probeVideoMeta', () => {
  it('parses width/height/duration from a valid ffprobe JSON stream', async () => {
    mockExecFileOnce((cb) => cb(null, { stdout: ffprobeJson({}), stderr: '' }));

    const result = await probeVideoMeta('/tmp/some-video.mp4');

    expect(result).toEqual({ durationSeconds: 9.541, width: 1080, height: 1920 });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [file, args] = mockExecFile.mock.calls[0];
    expect(file).toBe('ffprobe');
    expect(args).toEqual([
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration:stream_tags=rotate:stream_side_data=rotation:format=duration',
      '-of', 'json',
      '/tmp/some-video.mp4',
    ]);
  });

  it('accepts an https URL as input (ffprobe supports both local paths and URLs)', async () => {
    mockExecFileOnce((cb) => cb(null, { stdout: ffprobeJson({ stream: { width: 720, height: 1280, duration: '3.2' } }), stderr: '' }));

    const result = await probeVideoMeta('https://r2.example.com/presigned-clip-url');

    expect(result).toEqual({ durationSeconds: 3.2, width: 720, height: 1280 });
  });

  it('swaps width/height when the legacy `rotate` tag is ±90°', async () => {
    mockExecFileOnce((cb) =>
      cb(null, {
        stdout: ffprobeJson({ stream: { width: 1920, height: 1080, duration: '5', tags: { rotate: '90' } } }),
        stderr: '',
      }),
    );

    const result = await probeVideoMeta('/tmp/portrait-rotated.mp4');

    expect(result).toEqual({ durationSeconds: 5, width: 1080, height: 1920 });
  });

  it('swaps width/height when the modern displaymatrix side_data_list rotation is -90°', async () => {
    mockExecFileOnce((cb) =>
      cb(null, {
        stdout: ffprobeJson({
          stream: { width: 1920, height: 1080, duration: '5', side_data_list: [{ rotation: -90 }] },
        }),
        stderr: '',
      }),
    );

    const result = await probeVideoMeta('/tmp/portrait-rotated-2.mp4');

    expect(result).toEqual({ durationSeconds: 5, width: 1080, height: 1920 });
  });

  it('does NOT swap for a 180° rotation (not a ±90° turn)', async () => {
    mockExecFileOnce((cb) =>
      cb(null, {
        stdout: ffprobeJson({ stream: { width: 1920, height: 1080, duration: '5', tags: { rotate: '180' } } }),
        stderr: '',
      }),
    );

    const result = await probeVideoMeta('/tmp/upside-down.mp4');

    expect(result).toEqual({ durationSeconds: 5, width: 1920, height: 1080 });
  });

  it('reads image dimensions with a null duration (no video stream/format duration)', async () => {
    mockExecFileOnce((cb) =>
      cb(null, { stdout: ffprobeJson({ stream: { width: 800, height: 600, duration: undefined } }), stderr: '' }),
    );

    const result = await probeVideoMeta('/tmp/photo.jpg');

    expect(result).toEqual({ durationSeconds: null, width: 800, height: 600 });
  });

  it('falls back to format.duration when the stream has no duration (e.g. audio-only input)', async () => {
    mockExecFileOnce((cb) =>
      cb(null, { stdout: ffprobeJson({ stream: null, formatDuration: '12.5' }), stderr: '' }),
    );

    const result = await probeVideoMeta('/tmp/audio.m4a');

    expect(result).toEqual({ durationSeconds: 12.5, width: null, height: null });
  });

  it('returns all-null fields on unparseable JSON, never throws', async () => {
    mockExecFileOnce((cb) => cb(null, { stdout: 'not json', stderr: '' }));

    await expect(probeVideoMeta('/tmp/broken.mp4')).resolves.toEqual({
      durationSeconds: null,
      width: null,
      height: null,
    });
  });

  it('returns all-null fields (never throws) when execFile errors (e.g. non-zero exit, binary missing)', async () => {
    mockExecFileOnce((cb) => cb(new Error('ffprobe: command not found'), { stdout: '', stderr: '' }));

    await expect(probeVideoMeta('/tmp/some-video.mp4')).resolves.toEqual({
      durationSeconds: null,
      width: null,
      height: null,
    });
  });

  it('returns a null duration for a zero or negative duration (treated as unresolvable)', async () => {
    mockExecFileOnce((cb) => cb(null, { stdout: ffprobeJson({ stream: { duration: '0.000000' } }), stderr: '' }));

    const result = await probeVideoMeta('/tmp/zero.mp4');

    expect(result.durationSeconds).toBeNull();
  });
});

describe('probeDurationSeconds', () => {
  it('delegates to probeVideoMeta and returns only the duration', async () => {
    mockExecFileOnce((cb) => cb(null, { stdout: ffprobeJson({ stream: { duration: '9.541000' } }), stderr: '' }));

    const result = await probeDurationSeconds('/tmp/some-video.mp4');

    expect(result).toBe(9.541);
  });

  it('returns null on garbage/unparseable stdout, never throws', async () => {
    mockExecFileOnce((cb) => cb(null, { stdout: 'N/A', stderr: '' }));

    await expect(probeDurationSeconds('/tmp/broken.mp4')).resolves.toBeNull();
  });

  it('returns null (never throws) when execFile errors', async () => {
    mockExecFileOnce((cb) => cb(new Error('ffprobe: command not found'), { stdout: '', stderr: '' }));

    await expect(probeDurationSeconds('/tmp/some-video.mp4')).resolves.toBeNull();
  });
});
