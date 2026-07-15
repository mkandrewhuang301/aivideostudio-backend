// src/__tests__/queue/ffmpegProcessor.compose.test.ts
// Phase 13 Plan 06 (SC3/SC4/SC5/SC7): unit tests for buildComposeArgs — a PURE function that
// assembles the compose op's full ffmpeg argv (never a shell string, T-13-11). This suite tests
// argument/filter_complex CONSTRUCTION only, never a live ffmpeg binary/execFile — mirrors the
// established seam-testing convention from ffmpegWorker.test.ts (mock the ONE I/O boundary, test
// the pure orchestration/construction logic directly).
//
// RESEARCH.md Pitfall 2 / Anti-Patterns: the compose op must ALWAYS use the filter_complex
// scale/pad/concat pattern, NEVER the `-f concat` demuxer (that path is only correct for Phase
// 9.3's existing same-source `concat` op, whose inputs are guaranteed uniform).

// ffmpegProcessor.ts imports storage/r2.ts -> config.ts, which calls requireEnv() at module-eval
// time — mock config first (same convention as ffmpegWorker.test.ts) so importing the pure
// buildComposeArgs/escapeDrawtextText functions below doesn't require real env vars or R2 creds.
jest.mock('../../config', () => ({
  config: {
    replicateWebhookSecret: 'whsec_test',
    databaseUrl: 'mock://db',
    redisUrl: 'redis://localhost',
    r2AccountId: 'mock', r2AccessKeyId: 'mock', r2SecretAccessKey: 'mock',
    r2BucketName: 'mock', r2PublicDomain: '',
    firebaseProjectId: 'mock', firebaseClientEmail: 'mock@mock.iam.gserviceaccount.com',
    firebasePrivateKey: 'mock-key', apnsAuthKey: 'mock-key', apnsKeyId: 'mock',
    apnsTeamId: 'mock', apnsBundleId: 'mock', replicateApiToken: 'mock-token',
    hiveApiKey: 'mock-hive-key', publicBaseUrl: 'https://mock.example.com',
    port: 3000, nodeEnv: 'test',
  },
}));

import type { ComposeSpec } from '../../queue/ffmpegWorker';
import { buildComposeArgs, resolveComposeCanvas } from '../../queue/ffmpegProcessor';

function baseSpec(overrides: Partial<ComposeSpec> = {}): ComposeSpec {
  return {
    aspectRatio: '9:16',
    clips: [
      { r2Key: 'projects/p1/clips/a.mp4', mediaType: 'video', trimStartSeconds: 0, trimEndSeconds: 4 },
      { r2Key: 'projects/p1/clips/b.mp4', mediaType: 'video', trimStartSeconds: 1, trimEndSeconds: 6 },
    ],
    textOverlays: [],
    audioClips: [],
    captionCues: [],
    captionStyle: { fontSize: 64, color: '#FFFFFF', highlightColor: '#FFFF00', position: 'bottom' },
    ...overrides,
  };
}

function filterComplexOf(args: string[]): string {
  const idx = args.indexOf('-filter_complex');
  expect(idx).toBeGreaterThan(-1);
  return args[idx + 1];
}

describe('buildComposeArgs', () => {
  it('assembles scale/pad/concat filter_complex for a 2-clip 9:16 spec, never the demuxer (Pitfall 2)', () => {
    const args = buildComposeArgs({
      spec: baseSpec(),
      clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
      audioPaths: [],
      assPath: null,
      textOverlayAssPath: null,
      fontsDir: '/app/assets/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);

    expect(graph.match(/scale=1080:1920/g)).toHaveLength(2);
    expect(graph.match(/pad=1080:1920/g)).toHaveLength(2);
    expect(graph).toContain('concat=n=2:v=1:a=1');

    // Never the concat demuxer path.
    const joined = args.join(' ');
    expect(joined).not.toMatch(/-f concat/);

    // filter_complex is ONE argv element (never interpolated into a shell string).
    expect(args.filter((a: string) => a === '-filter_complex')).toHaveLength(1);
  });

  it('honors the 1080p-cap canvas table for every aspect ratio', () => {
    const cases: Array<[ComposeSpec['aspectRatio'], string]> = [
      ['9:16', '1080:1920'],
      ['4:5', '1080:1350'],
      ['1:1', '1080:1080'],
      ['16:9', '1920:1080'],
    ];
    for (const [aspectRatio, expected] of cases) {
      const args = buildComposeArgs({
        spec: baseSpec({ aspectRatio, clips: [baseSpec().clips[0]] }),
        clipPaths: ['/tmp/clip0.mp4'],
        audioPaths: [],
        assPath: null,
        textOverlayAssPath: null,
        fontsDir: '/app/assets/fonts',
        outPath: '/tmp/out.mp4',
      });
      expect(filterComplexOf(args)).toContain(`scale=${expected}`);
    }
  });

  describe("resolveComposeCanvas — 'original' aspect ratio (Plan 13-22 B2)", () => {
    it("resolves originalCanvasWidth/Height as-is when already even", () => {
      expect(resolveComposeCanvas({ aspectRatio: 'original', originalCanvasWidth: 1920, originalCanvasHeight: 1080 })).toEqual({
        width: 1920,
        height: 1080,
      });
    });

    it('forces odd dimensions down to the nearest even number (h264 requirement)', () => {
      expect(resolveComposeCanvas({ aspectRatio: 'original', originalCanvasWidth: 1921, originalCanvasHeight: 1081 })).toEqual({
        width: 1920,
        height: 1080,
      });
    });

    it('falls back to 1080x1920 when originalCanvasWidth/Height are unknown', () => {
      expect(resolveComposeCanvas({ aspectRatio: 'original' })).toEqual({ width: 1080, height: 1920 });
    });

    it('falls back to 1080x1920 when only one of width/height is known', () => {
      expect(resolveComposeCanvas({ aspectRatio: 'original', originalCanvasWidth: 1920 })).toEqual({
        width: 1080,
        height: 1920,
      });
    });

    it("buildComposeArgs threads the resolved+even-forced 'original' canvas into the scale/pad filters", () => {
      const args = buildComposeArgs({
        spec: baseSpec({ aspectRatio: 'original', originalCanvasWidth: 721, originalCanvasHeight: 1281, clips: [baseSpec().clips[0]] }),
        clipPaths: ['/tmp/clip0.mp4'],
        audioPaths: [],
        assPath: null,
        textOverlayAssPath: null,
        fontsDir: '/app/assets/fonts',
        outPath: '/tmp/out.mp4',
      });
      expect(filterComplexOf(args)).toContain('scale=720:1280');
    });
  });

  it('includes a libass filter referencing textOverlayAssPath + fontsDir when textOverlays are present (G4 — replaces drawtext)', () => {
    const args = buildComposeArgs({
      spec: baseSpec({
        textOverlays: [
          { text: 'Hello world', xNorm: 0.5, yNorm: 0.1, startSeconds: 1, endSeconds: 3 },
        ],
      }),
      clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
      audioPaths: [],
      assPath: null,
      textOverlayAssPath: '/tmp/ffmpeg-gen-1/textOverlays.ass',
      fontsDir: '/app/assets/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);

    expect(graph).toContain('ass=filename=/tmp/ffmpeg-gen-1/textOverlays.ass:fontsdir=/app/assets/fonts');
    expect(graph).not.toContain('drawtext=');
  });

  it('omits the text-overlay ass filter entirely when textOverlays is empty / textOverlayAssPath is null', () => {
    const args = buildComposeArgs({
      spec: baseSpec({ textOverlays: [] }),
      clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
      audioPaths: [],
      assPath: null,
      textOverlayAssPath: null,
      fontsDir: '/app/assets/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);

    expect(graph).not.toContain('drawtext=');
    // Only the caption ass filter could ever appear here, and captionCues is empty too — no ass filter at all.
    expect(graph).not.toContain('ass=filename=');
  });

  it('chains the text-overlay ass filter BEFORE the caption ass filter when both are present', () => {
    const args = buildComposeArgs({
      spec: baseSpec({
        textOverlays: [{ text: 'Hi', xNorm: 0.5, yNorm: 0.1, startSeconds: 0, endSeconds: 2 }],
        captionCues: [{ startSeconds: 0, endSeconds: 1, words: [{ text: 'hi', startSeconds: 0, endSeconds: 1 }] }],
      }),
      clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
      audioPaths: [],
      assPath: '/tmp/ffmpeg-gen-1/captions.ass',
      textOverlayAssPath: '/tmp/ffmpeg-gen-1/textOverlays.ass',
      fontsDir: '/app/assets/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);

    const textOverlayIdx = graph.indexOf('textOverlays.ass');
    const captionIdx = graph.indexOf('captions.ass');
    expect(textOverlayIdx).toBeGreaterThan(-1);
    expect(captionIdx).toBeGreaterThan(-1);
    expect(textOverlayIdx).toBeLessThan(captionIdx);
  });

  it('includes an ass filter referencing assPath + fontsDir when captionCues are present', () => {
    const args = buildComposeArgs({
      spec: baseSpec({
        captionCues: [
          { startSeconds: 0, endSeconds: 1, words: [{ text: 'hi', startSeconds: 0, endSeconds: 1 }] },
        ],
      }),
      clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
      audioPaths: [],
      assPath: '/tmp/ffmpeg-gen-1/captions.ass',
      textOverlayAssPath: null,
      fontsDir: '/app/assets/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);

    expect(graph).toContain('ass=filename=/tmp/ffmpeg-gen-1/captions.ass:fontsdir=/app/assets/fonts');
  });

  it('omits the ass filter entirely when captionCues is empty / assPath is null', () => {
    const args = buildComposeArgs({
      spec: baseSpec({ captionCues: [] }),
      clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
      audioPaths: [],
      assPath: null,
      textOverlayAssPath: null,
      fontsDir: '/app/assets/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);

    expect(graph).not.toContain('ass=filename=');
  });

  it('mixes independently-timed audio clips over the concatenated clip audio via adelay + amix', () => {
    const args = buildComposeArgs({
      spec: baseSpec({
        audioClips: [
          { r2Key: 'projects/p1/audio/x.m4a', startOffsetSeconds: 2, trimStartSeconds: 0, trimEndSeconds: 5 },
        ],
      }),
      clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
      audioPaths: ['/tmp/audio0.m4a'],
      assPath: null,
      textOverlayAssPath: null,
      fontsDir: '/app/assets/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);

    expect(graph).toContain('adelay=2000:all=1');
    expect(graph).toContain('amix=inputs=2');
    // The audio input must actually appear as a distinct -i argument.
    expect(args).toContain('/tmp/audio0.m4a');
  });

  it('synthesizes a looped still-image video segment + silent audio track for image clips', () => {
    const args = buildComposeArgs({
      spec: baseSpec({
        clips: [
          { r2Key: 'projects/p1/clips/photo.jpg', mediaType: 'image', trimStartSeconds: 0, trimEndSeconds: 3 },
        ],
      }),
      clipPaths: ['/tmp/photo.jpg'],
      audioPaths: [],
      assPath: null,
      textOverlayAssPath: null,
      fontsDir: '/app/assets/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);

    expect(args).toContain('-loop');
    expect(graph).toContain('anullsrc=');
    expect(graph).toContain('concat=n=1:v=1:a=1');
  });

  it('ends the argv with -c:v libx264 -c:a aac and the output path, mapping the final video+audio labels', () => {
    const args = buildComposeArgs({
      spec: baseSpec(),
      clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
      audioPaths: [],
      assPath: null,
      textOverlayAssPath: null,
      fontsDir: '/app/assets/fonts',
      outPath: '/tmp/final.mp4',
    });

    expect(args.slice(-5)).toEqual(['-c:v', 'libx264', '-c:a', 'aac', '/tmp/final.mp4']);
    expect(args).toContain('-map');
  });
});
