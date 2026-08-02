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
import {
  atempoChain,
  audioTailSeconds,
  buildComposeArgs,
  resolveComposeCanvas,
  speedSegments,
} from '../../queue/ffmpegProcessor';

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
      lutsDir: '/app/assets/luts',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);

    expect(graph.match(/scale=1080:1920/g)).toHaveLength(2);
    expect(graph.match(/pad=w='max\(iw,1080\)/g)).toHaveLength(2);
    expect(graph).toContain('concat=n=2:v=1:a=1');

    // Never the concat demuxer path.
    const joined = args.join(' ');
    expect(joined).not.toMatch(/-f concat/);

    // filter_complex is ONE argv element (never interpolated into a shell string).
    expect(args.filter((a: string) => a === '-filter_complex')).toHaveLength(1);
  });

  it('applies each video clip source volume and defaults legacy compose jobs to full level', () => {
    const spec = baseSpec({
      clips: [
        { ...baseSpec().clips[0], volume: 0.35 },
        { ...baseSpec().clips[1] },
      ],
    });
    const args = buildComposeArgs({
      spec,
      clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
      audioPaths: [],
      assPath: null,
      textOverlayAssPath: null,
      fontsDir: '/app/assets/fonts',
      lutsDir: '/app/assets/luts',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);

    expect(graph).toContain('asetpts=PTS-STARTPTS,volume=0.35[a0]');
    expect(graph).toContain('asetpts=PTS-STARTPTS,volume=1[a1]');
  });

  it('applies per-clip scale and normalized position before cropping to the canvas', () => {
    const spec = baseSpec({
      clips: [{ ...baseSpec().clips[0], scale: 1.75, xNorm: 0.75, yNorm: 0.25 }],
    });
    const graph = filterComplexOf(buildComposeArgs({
      spec,
      clipPaths: ['/tmp/clip0.mp4'],
      audioPaths: [],
      assPath: null,
      textOverlayAssPath: null,
      fontsDir: '/app/assets/fonts',
      lutsDir: '/app/assets/luts',
      outPath: '/tmp/out.mp4',
    }));

    expect(graph).toContain('scale=iw*1.75:ih*1.75');
    expect(graph).toContain("pad=w='max(iw,1080)+2*abs(270)'");
    expect(graph).toContain("h='max(ih,1920)+2*abs(-480)'");
    expect(graph).toContain("x='(ow-iw)/2+270':y='(oh-ih)/2+-480'");
    expect(graph).toContain('crop=1080:1920:(iw-1080)/2:(ih-1920)/2');
  });

  describe('clip speed', () => {
    it('retimes uniform-speed video and pitch-preserving audio together', () => {
      const spec = baseSpec({
        clips: [{ ...baseSpec().clips[0], playbackRate: 2 }],
      });
      const graph = filterComplexOf(buildComposeArgs({
        spec,
        clipPaths: ['/tmp/clip0.mp4'],
        audioPaths: [],
        assPath: null,
        textOverlayAssPath: null,
        fontsDir: '/app/assets/fonts',
        lutsDir: '/app/assets/luts',
        outPath: '/tmp/out.mp4',
      }));

      expect(graph).toContain('setpts=(PTS-STARTPTS)/2');
      expect(graph).toContain('atempo=2.000000');
      expect(speedSegments(4, 2).at(-1)?.renderedEnd).toBe(2);
    });

    it('samples a variable curve into the same bounded 16-slice graph used by iOS', () => {
      const curve = [{ position: 0, rate: 0.5 }, { position: 1, rate: 2 }];
      const segments = speedSegments(8, 1, curve);
      expect(segments).toHaveLength(16);
      expect(segments[0].sourceStart).toBe(0);
      expect(segments.at(-1)?.sourceEnd).toBe(8);
      expect(segments.every((segment) => segment.renderedEnd > segment.renderedStart)).toBe(true);

      const spec = baseSpec({
        clips: [{ ...baseSpec().clips[0], speedCurve: curve }],
      });
      const graph = filterComplexOf(buildComposeArgs({
        spec,
        clipPaths: ['/tmp/clip0.mp4'],
        audioPaths: [],
        assPath: null,
        textOverlayAssPath: null,
        fontsDir: '/app/assets/fonts',
        lutsDir: '/app/assets/luts',
        outPath: '/tmp/out.mp4',
      }));
      expect(graph).toContain('concat=n=16:v=1:a=1[v0][a0]');
    });

    it('chains legal atempo stages for the full 0.1x...10x range', () => {
      for (const rate of [0.1, 0.2, 0.5, 1, 2, 5, 10]) {
        const factors = atempoChain(rate).split(',').map((part) => Number(part.split('=')[1]));
        expect(factors.every((factor) => factor >= 0.5 && factor <= 2)).toBe(true);
        expect(factors.reduce((product, factor) => product * factor, 1)).toBeCloseTo(rate, 5);
      }
    });

    it('uses rendered speed duration when calculating a trailing independent-audio pad', () => {
      const spec = baseSpec({
        clips: [{ ...baseSpec().clips[0], playbackRate: 2 }],
        audioClips: [{
          r2Key: 'projects/p1/audio/a.m4a',
          startOffsetSeconds: 0,
          trimStartSeconds: 0,
          trimEndSeconds: 3,
        }],
      });
      expect(audioTailSeconds(spec)).toBe(1);
    });
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
        lutsDir: '/app/assets/luts',
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
        lutsDir: '/app/assets/luts',
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
      lutsDir: '/app/assets/luts',
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
      lutsDir: '/app/assets/luts',
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
      lutsDir: '/app/assets/luts',
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
      lutsDir: '/app/assets/luts',
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
      lutsDir: '/app/assets/luts',
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
      lutsDir: '/app/assets/luts',
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
      lutsDir: '/app/assets/luts',
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
      lutsDir: '/app/assets/luts',
      outPath: '/tmp/final.mp4',
    });

    expect(args.slice(-5)).toEqual(['-c:v', 'libx264', '-c:a', 'aac', '/tmp/final.mp4']);
    expect(args).toContain('-map');
  });

  // 2026-07-27 (~/.planning/notes/2026-07-27-audio-outlives-video.md): audio is never shortened to
  // fit the video. When it outlives the video the EXPORT has to grow too — the preview already
  // does — so the mix runs to the longest input and the video is padded with black to match.
  describe('audio outliving the video', () => {
    // baseSpec's two clips are 4s + 5s = 9s of video.
    const audioPastTheEnd = {
      r2Key: 'projects/p1/audio/long.m4a',
      startOffsetSeconds: 6,
      trimStartSeconds: 0,
      trimEndSeconds: 8, // ends at 14s — 5s past the last video frame
    };

    it('pads the video with black for exactly the overhang and mixes to the longest input', () => {
      const args = buildComposeArgs({
        spec: baseSpec({ audioClips: [audioPastTheEnd] }),
        clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
        audioPaths: ['/tmp/audio0.m4a'],
        assPath: null,
        textOverlayAssPath: null,
        fontsDir: '/app/assets/fonts',
        lutsDir: '/app/assets/luts',
        outPath: '/tmp/out.mp4',
      });
      const graph = filterComplexOf(args);

      expect(graph).toContain('tpad=stop_mode=add:stop_duration=5.000:color=black');
      expect(graph).toContain('duration=longest');
      // The padded stream, not the raw concat, must be what gets mapped to the output.
      expect(graph).toContain('[vpad]');
      expect(args).toContain('[vpad]');
    });

    it('measures the overhang from the LATEST-ending clip, not the last one in the array', () => {
      const args = buildComposeArgs({
        spec: baseSpec({
          audioClips: [
            audioPastTheEnd, // ends at 14s
            { r2Key: 'projects/p1/audio/short.m4a', startOffsetSeconds: 0, trimStartSeconds: 0, trimEndSeconds: 2 },
          ],
        }),
        clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
        audioPaths: ['/tmp/audio0.m4a', '/tmp/audio1.m4a'],
        assPath: null,
        textOverlayAssPath: null,
        fontsDir: '/app/assets/fonts',
        lutsDir: '/app/assets/luts',
        outPath: '/tmp/out.mp4',
      });

      expect(filterComplexOf(args)).toContain('stop_duration=5.000');
    });

    it('adds no padding at all when the video is the longest thing in the project', () => {
      const args = buildComposeArgs({
        spec: baseSpec({
          audioClips: [
            { r2Key: 'projects/p1/audio/x.m4a', startOffsetSeconds: 0, trimStartSeconds: 0, trimEndSeconds: 3 },
          ],
        }),
        clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
        audioPaths: ['/tmp/audio0.m4a'],
        assPath: null,
        textOverlayAssPath: null,
        fontsDir: '/app/assets/fonts',
        lutsDir: '/app/assets/luts',
        outPath: '/tmp/out.mp4',
      });
      const graph = filterComplexOf(args);

      expect(graph).not.toContain('tpad');
      expect(graph).not.toContain('[vpad]');
    });

    it('pads past burned captions and text overlays rather than retiming them', () => {
      const args = buildComposeArgs({
        spec: baseSpec({
          audioClips: [audioPastTheEnd],
          textOverlays: [{ text: 'hi', xNorm: 0.5, yNorm: 0.5, startSeconds: 0, endSeconds: 2 }],
          captionCues: [{ startSeconds: 0, endSeconds: 2, words: [{ text: 'hi', startSeconds: 0, endSeconds: 2 }] }],
        }),
        clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
        audioPaths: ['/tmp/audio0.m4a'],
        assPath: '/tmp/captions.ass',
        textOverlayAssPath: '/tmp/text.ass',
        fontsDir: '/app/assets/fonts',
        lutsDir: '/app/assets/luts',
        outPath: '/tmp/out.mp4',
      });
      const graph = filterComplexOf(args);

      // The tpad must consume the FINAL burned label, so both ass passes land on real video.
      expect(graph).toContain('[vout]fps=30,tpad=');
    });

    // Regression, 2026-07-27: verified against a REAL ffmpeg run, which is the only way this is
    // visible. Without the fps normalization the chain reaching tpad (trim -> setpts -> concat)
    // carries no usable frame rate, tpad spaces its pad frames wrong, and the encoder drops most
    // of them — a 4.000s tail rendered as 1.1s of video against 7.0s of audio. The container
    // duration reads correct anyway because the AUDIO track sets it, so neither this file nor a
    // format=duration probe can catch it; only probing the video stream can. Keep them adjacent
    // and in this order.
    it('normalizes the frame rate immediately before padding, or the pad frames get dropped', () => {
      const args = buildComposeArgs({
        spec: baseSpec({ audioClips: [audioPastTheEnd] }),
        clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
        audioPaths: ['/tmp/audio0.m4a'],
        assPath: null,
        textOverlayAssPath: null,
        fontsDir: '/app/assets/fonts',
        lutsDir: '/app/assets/luts',
        outPath: '/tmp/out.mp4',
      });
      const graph = filterComplexOf(args);

      expect(graph).toContain('fps=30,tpad=');
      // Order matters: fps AFTER tpad does not rescue the already-dropped frames.
      expect(graph).not.toMatch(/tpad=[^;]*,fps=/);
    });
  });

  // 2026-07-27: deleting the last clip no longer collapses a project, so a clips-less spec is now
  // reachable. It exports as an all-black mp4 for the audio's length — the same thing the editor
  // previews there — via one synthesized lavfi segment, so `concat=n=` never sees zero.
  describe('audio-only project (no video clips)', () => {
    const audioOnlySpec = () =>
      baseSpec({
        clips: [],
        audioClips: [
          { r2Key: 'projects/p1/audio/song.m4a', startOffsetSeconds: 2, trimStartSeconds: 0, trimEndSeconds: 10 },
        ],
      });

    it('synthesizes a black video segment spanning the full audio length', () => {
      const args = buildComposeArgs({
        spec: audioOnlySpec(),
        clipPaths: [],
        audioPaths: ['/tmp/audio0.m4a'],
        assPath: null,
        textOverlayAssPath: null,
        fontsDir: '/app/assets/fonts',
        lutsDir: '/app/assets/luts',
        outPath: '/tmp/out.mp4',
      });
      const graph = filterComplexOf(args);

      // 9:16 canvas, audio ends at 2 + 10 = 12s.
      expect(args).toContain('color=c=black:s=1080x1920:d=12.000');
      expect(graph).toContain('concat=n=1:v=1:a=1');
      // The black segment occupies input 0, so the real audio must be indexed from 1.
      expect(graph).toContain('[1:a]atrim=');
    });

    it('does not ALSO tail-pad the synthesized segment (that would double the file length)', () => {
      const args = buildComposeArgs({
        spec: audioOnlySpec(),
        clipPaths: [],
        audioPaths: ['/tmp/audio0.m4a'],
        assPath: null,
        textOverlayAssPath: null,
        fontsDir: '/app/assets/fonts',
        lutsDir: '/app/assets/luts',
        outPath: '/tmp/out.mp4',
      });

      expect(filterComplexOf(args)).not.toContain('tpad');
    });

    it('throws rather than emit a zero-length file when there is no video AND no audio', () => {
      expect(() =>
        buildComposeArgs({
          spec: baseSpec({ clips: [], audioClips: [] }),
          clipPaths: [],
          audioPaths: [],
          assPath: null,
          textOverlayAssPath: null,
          fontsDir: '/app/assets/fonts',
          lutsDir: '/app/assets/luts',
          outPath: '/tmp/out.mp4',
        }),
      ).toThrow(/nothing to export/);
    });
  });

  // Studio color filters. The graph shape here was wrong twice on the way in and both mistakes
  // were silent — the render succeeded and simply looked wrong — so these tests pin the exact
  // shape rather than just asserting "lut3d appears somewhere".
  describe('color filters', () => {
    const oneFilter = (
      over: Partial<NonNullable<ComposeSpec['filters']>[number]> = {},
    ): NonNullable<ComposeSpec['filters']>[number] => ({
      filterId: 'noir',
      intensity: 1,
      startOffsetSeconds: 2,
      durationSeconds: 3,
      ...over,
    });

    function graphFor(filters: NonNullable<ComposeSpec['filters']>): string {
      return filterComplexOf(
        buildComposeArgs({
          spec: baseSpec({ filters }),
          clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
          audioPaths: [],
          assPath: null,
          textOverlayAssPath: null,
          fontsDir: '/app/assets/fonts',
          lutsDir: '/app/assets/luts',
          outPath: '/tmp/out.mp4',
        }),
      );
    }

    it('adds nothing when the project has no filters, present-but-empty or absent', () => {
      expect(graphFor([])).not.toContain('lut3d');
      // Absent must behave identically to empty — snapshots built before this feature are
      // replayed verbatim on re-export and have no `filters` key at all.
      const args = buildComposeArgs({
        spec: baseSpec(),
        clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
        audioPaths: [],
        assPath: null,
        textOverlayAssPath: null,
        fontsDir: '/app/assets/fonts',
        lutsDir: '/app/assets/luts',
        outPath: '/tmp/out.mp4',
      });
      expect(filterComplexOf(args)).not.toContain('lut3d');
    });

    it('grades with a bare time-windowed lut3d at full intensity (no blend pass needed)', () => {
      const graph = graphFor([oneFilter()]);
      expect(graph).toContain(
        "lut3d=file=/app/assets/luts/noir.cube:interp=tetrahedral:enable='between(t,2,5)'",
      );
      expect(graph).not.toContain('blend=');
      expect(graph).not.toContain('split');
    });

    it('puts `enable` on the lut3d and NEVER on the blend', () => {
      // A disabled multi-input filter passes through its FIRST input, which here is the graded
      // branch — so `enable` on the blend would apply the grade everywhere EXCEPT the window,
      // exactly inverted. Confirmed by rendering real frames.
      const graph = graphFor([oneFilter({ intensity: 0.5 })]);
      const blendPart = graph.split(';').find((p) => p.includes('blend='));
      expect(blendPart).toBeDefined();
      expect(blendPart).not.toContain('enable');
      const lutPart = graph.split(';').find((p) => p.includes('lut3d'));
      expect(lutPart).toContain("enable='between(t,2,5)'");
    });

    it('feeds blend the GRADED branch first, since blend input 0 is the top layer', () => {
      // `[keep][graded]` is the intuitive reading and is wrong: normal mode at full opacity
      // outputs the top layer, so that ordering emits the ungraded frame and the filter
      // silently does nothing at all.
      const graph = graphFor([oneFilter({ intensity: 0.4 })]);
      expect(graph).toContain('[fgraded0][fkeep0]blend=all_mode=normal:all_opacity=0.4');
    });

    it('chains stacked filters in spec order, each reading the previous result', () => {
      const graph = graphFor([
        oneFilter({ filterId: 'noir' }),
        oneFilter({ filterId: 'sunset', startOffsetSeconds: 0, durationSeconds: 9 }),
      ]);
      expect(graph).toContain('[vconcat]lut3d=file=/app/assets/luts/noir.cube');
      expect(graph).toContain('[vfilt0]lut3d=file=/app/assets/luts/sunset.cube');
    });

    it('grades the footage BEFORE burning text, so a filter never tints the lettering', () => {
      const args = buildComposeArgs({
        spec: baseSpec({
          filters: [oneFilter()],
          textOverlays: [
            {
              text: 'hi',
              xNorm: 0.5,
              yNorm: 0.5,
              widthNorm: 1,
              rotation: 0,
              startSeconds: 0,
              endSeconds: 3,
            },
          ],
        }),
        clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
        audioPaths: [],
        assPath: null,
        textOverlayAssPath: '/tmp/text.ass',
        fontsDir: '/app/assets/fonts',
        lutsDir: '/app/assets/luts',
        outPath: '/tmp/out.mp4',
      });
      const graph = filterComplexOf(args);
      expect(graph.indexOf('lut3d')).toBeLessThan(graph.indexOf('ass=filename=/tmp/text.ass'));
      // The ass pass must consume the GRADED label, not the raw concat.
      expect(graph).toContain('[vfilt0]ass=filename=/tmp/text.ass');
    });

    it('skips zero-length and zero-intensity filters instead of emitting a dead LUT pass', () => {
      expect(graphFor([oneFilter({ durationSeconds: 0 })])).not.toContain('lut3d');
      expect(graphFor([oneFilter({ intensity: 0 })])).not.toContain('lut3d');
    });
  });
});
