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
import { buildComposeArgs, escapeDrawtextText } from '../../queue/ffmpegProcessor';

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
        fontsDir: '/app/assets/fonts',
        outPath: '/tmp/out.mp4',
      });
      expect(filterComplexOf(args)).toContain(`scale=${expected}`);
    }
  });

  it('produces one drawtext per text overlay with an enable=between(t,start,end) window and an Inter-Bold fontfile', () => {
    const args = buildComposeArgs({
      spec: baseSpec({
        textOverlays: [
          { text: 'Hello world', xNorm: 0.5, yNorm: 0.1, startSeconds: 1, endSeconds: 3 },
        ],
      }),
      clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
      audioPaths: [],
      assPath: null,
      fontsDir: '/app/assets/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);

    expect(graph).toContain('drawtext=');
    expect(graph).toContain('fontfile=/app/assets/fonts/Inter-Bold.ttf');
    expect(graph).toContain("enable='between(t,1,3)'");
  });

  it('escapes drawtext overlay text containing : and \' so neither reaches the filter graph unescaped (T-13-11)', () => {
    const rawText = "Hello: it's a test";
    const args = buildComposeArgs({
      spec: baseSpec({
        textOverlays: [
          { text: rawText, xNorm: 0.5, yNorm: 0.1, startSeconds: 0, endSeconds: 2 },
        ],
      }),
      clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
      audioPaths: [],
      assPath: null,
      fontsDir: '/app/assets/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);

    // The raw unescaped substring must never survive verbatim in the constructed filter graph.
    expect(graph).not.toContain(`text='${rawText}'`);
    expect(graph).toContain(escapeDrawtextText(rawText));
  });

  it('escapeDrawtextText escapes colons, single quotes, backslashes, and percent signs', () => {
    expect(escapeDrawtextText('a:b')).toBe('a\\:b');
    expect(escapeDrawtextText("a'b")).toBe("a\\'b");
    expect(escapeDrawtextText('a\\b')).toBe('a\\\\b');
    expect(escapeDrawtextText('a%b')).toBe('a\\%b');
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
      fontsDir: '/app/assets/fonts',
      outPath: '/tmp/final.mp4',
    });

    expect(args.slice(-5)).toEqual(['-c:v', 'libx264', '-c:a', 'aac', '/tmp/final.mp4']);
    expect(args).toContain('-map');
  });
});
