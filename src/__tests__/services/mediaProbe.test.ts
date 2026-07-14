// src/__tests__/services/mediaProbe.test.ts
// Unit tests for probeDurationSeconds (Plan 13-20 Task B1/B3) — mocks child_process.execFile so
// no real ffprobe binary is invoked. Contract under test: happy path parses the csv duration,
// and EVERY failure mode (garbage output, non-zero exit / execFile error) resolves to `null`
// rather than throwing — callers (route + self-heal path) rely on this to never fail an import.

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { probeDurationSeconds } from '../../services/mediaProbe';

function mockExecFileOnce(impl: (cb: (err: unknown, result: { stdout: string; stderr: string }) => void) => void) {
  mockExecFile.mockImplementationOnce((_file: string, _args: string[], cb: (err: unknown, result: { stdout: string; stderr: string }) => void) => {
    impl(cb);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('probeDurationSeconds', () => {
  it('parses a valid ffprobe csv duration into a float', async () => {
    mockExecFileOnce((cb) => cb(null, { stdout: '9.541000\n', stderr: '' }));

    const result = await probeDurationSeconds('/tmp/some-video.mp4');

    expect(result).toBe(9.541);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [file, args] = mockExecFile.mock.calls[0];
    expect(file).toBe('ffprobe');
    expect(args).toEqual(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '/tmp/some-video.mp4']);
  });

  it('accepts an https URL as input (ffprobe supports both local paths and URLs)', async () => {
    mockExecFileOnce((cb) => cb(null, { stdout: '3.2\n', stderr: '' }));

    const result = await probeDurationSeconds('https://r2.example.com/presigned-clip-url');

    expect(result).toBe(3.2);
  });

  it('returns null on garbage/unparseable stdout, never throws', async () => {
    mockExecFileOnce((cb) => cb(null, { stdout: 'N/A\n', stderr: '' }));

    await expect(probeDurationSeconds('/tmp/broken.mp4')).resolves.toBeNull();
  });

  it('returns null on an empty stdout', async () => {
    mockExecFileOnce((cb) => cb(null, { stdout: '', stderr: '' }));

    await expect(probeDurationSeconds('/tmp/empty.mp4')).resolves.toBeNull();
  });

  it('returns null (never throws) when execFile errors (e.g. non-zero exit, binary missing)', async () => {
    mockExecFileOnce((cb) => cb(new Error('ffprobe: command not found'), { stdout: '', stderr: '' }));

    await expect(probeDurationSeconds('/tmp/some-video.mp4')).resolves.toBeNull();
  });

  it('returns null for a zero or negative duration (treated as unresolvable)', async () => {
    mockExecFileOnce((cb) => cb(null, { stdout: '0.000000\n', stderr: '' }));

    await expect(probeDurationSeconds('/tmp/zero.mp4')).resolves.toBeNull();
  });
});
