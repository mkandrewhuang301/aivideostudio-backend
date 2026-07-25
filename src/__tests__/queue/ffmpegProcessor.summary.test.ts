jest.mock('../../config', () => ({
  config: {
    replicateWebhookSecret: 'whsec_test',
    databaseUrl: 'mock://db', redisUrl: 'redis://localhost',
    r2AccountId: 'mock', r2AccessKeyId: 'mock', r2SecretAccessKey: 'mock',
    r2BucketName: 'mock', r2PublicDomain: '',
    firebaseProjectId: 'mock', firebaseClientEmail: 'mock@example.com',
    firebasePrivateKey: 'mock-key', apnsAuthKey: 'mock-key', apnsKeyId: 'mock',
    apnsTeamId: 'mock', apnsBundleId: 'mock', replicateApiToken: 'mock-token',
    hiveApiKey: 'mock', publicBaseUrl: 'https://mock.example.com',
    port: 3000, nodeEnv: 'test',
  },
}));

import { buildSummaryComposeArgs, buildSummarySizingFilter } from '../../queue/ffmpegProcessor';
import type { SummaryComposeSpec } from '../../queue/ffmpegWorker';

const SPEC: SummaryComposeSpec = {
  width: 1080,
  height: 1920,
  sourceR2Key: 'uploads/user/episode.mp4',
  clips: [
    { startSeconds: 10, endSeconds: 14, outputDurationSeconds: 4 },
    { startSeconds: 30, endSeconds: 36, outputDurationSeconds: 6 },
  ],
  narrationR2Key: 'generations/gen.narration.wav',
  musicR2Key: 'generations/gen.music.wav',
  musicVolume: 0.2,
  captionCues: [],
  captionStyle: {
    fontSize: 44,
    color: '#FFFFFF',
    highlightColor: '#FFD60A',
    position: 'bottom',
    karaoke: false,
    outlineWidth: 3,
    shadowDepth: 1.5,
    backgroundBox: false,
  },
};

describe('buildSummaryComposeArgs', () => {
  it('cuts one source at natural speed and centers a square edit inside the 9:16 canvas', () => {
    const args = buildSummaryComposeArgs({
      spec: SPEC,
      sourcePath: '/tmp/source.mp4',
      narrationPath: '/tmp/narration.wav',
      musicPath: '/tmp/music.wav',
      captionAssPath: '/tmp/captions.ass',
      fontsDir: '/tmp/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = args[args.indexOf('-filter_complex') + 1]!;

    expect(args.slice(0, 8)).toEqual([
      '-y', '-sws_flags', 'lanczos+accurate_rnd+full_chroma_int',
      '-i', '/tmp/source.mp4', '-i', '/tmp/narration.wav', '-stream_loop',
    ]);
    expect(graph).toContain('[0:v]split=2[src0][src1]');
    expect(graph).toContain('trim=start=10:end=14,setpts=1*(PTS-STARTPTS)');
    expect(graph).toContain('scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,pad=1080:1920:(ow-iw)/2:(oh-ih)/2');
    expect(graph).not.toContain('boxblur');
    expect(graph).toContain('concat=n=2:v=1:a=0');
    expect(graph).toContain('ass=filename=/tmp/captions.ass:fontsdir=/tmp/fonts');
    expect(graph).toContain('[1:a][bed]amix=inputs=2');
    expect(graph).not.toContain('[0:a]');
    expect(args).toContain('+faststart');
  });

  it('re-encodes at an explicit quality rather than libx264 defaults', () => {
    const args = buildSummaryComposeArgs({
      spec: SPEC,
      sourcePath: '/tmp/source.mp4',
      narrationPath: '/tmp/narration.wav',
      musicPath: null,
      captionAssPath: '/tmp/captions.ass',
      fontsDir: '/tmp/fonts',
      outPath: '/tmp/out.mp4',
    });

    expect(args[args.indexOf('-crf') + 1]).toBe('18');
    expect(args[args.indexOf('-preset') + 1]).toBe('medium');
    expect(args[args.indexOf('-b:a') + 1]).toBe('192k');
    // A source chapter/data track must not survive into the cut — it would keep the source's own
    // (much longer) duration and become the container's advertised length.
    expect(args).toContain('-dn');
    expect(args[args.indexOf('-map_chapters') + 1]).toBe('-1');
    // Nothing may reduce the canvas below the 1080-wide contract.
    expect(args).toContain('-pix_fmt');
    expect(args).not.toContain('-vf');
  });
});

describe('buildSummaryComposeArgs — "let the clip breathe" diegetic audio', () => {
  it('leaves the graph exactly as before when diegeticWindows is absent (backward compat)', () => {
    const withoutWindows = buildSummaryComposeArgs({
      spec: SPEC,
      sourcePath: '/tmp/source.mp4',
      narrationPath: '/tmp/narration.wav',
      musicPath: '/tmp/music.wav',
      captionAssPath: '/tmp/captions.ass',
      fontsDir: '/tmp/fonts',
      outPath: '/tmp/out.mp4',
    });
    const withEmptyWindows = buildSummaryComposeArgs({
      spec: { ...SPEC, diegeticWindows: [] },
      sourcePath: '/tmp/source.mp4',
      narrationPath: '/tmp/narration.wav',
      musicPath: '/tmp/music.wav',
      captionAssPath: '/tmp/captions.ass',
      fontsDir: '/tmp/fonts',
      outPath: '/tmp/out.mp4',
    });
    // Absent and empty are byte-identical to each other, and neither ever references [0:a].
    expect(withEmptyWindows).toEqual(withoutWindows);
    const graph = withoutWindows[withoutWindows.indexOf('-filter_complex') + 1]!;
    expect(graph).not.toContain('[0:a]');
    expect(graph).not.toContain('dieg');
  });

  it('adds an atrim/adelay branch per window and amixes it with narration+music at normalize=0', () => {
    const args = buildSummaryComposeArgs({
      spec: {
        ...SPEC,
        diegeticWindows: [
          { startSec: 4, endSec: 8, sourceClipStartSec: 30, sourceClipEndSec: 34 },
        ],
      },
      sourcePath: '/tmp/source.mp4',
      narrationPath: '/tmp/narration.wav',
      musicPath: '/tmp/music.wav',
      captionAssPath: '/tmp/captions.ass',
      fontsDir: '/tmp/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = args[args.indexOf('-filter_complex') + 1]!;

    expect(graph).toContain('[0:a]atrim=start=30:end=34,asetpts=PTS-STARTPTS,adelay=4000|4000[dieg0]');
    expect(graph).toContain('[2:a]volume=0.2[bed]');
    expect(graph).toContain('[1:a][bed][dieg0]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[aout]');
    expect(args).toEqual(expect.arrayContaining(['-map', '[aout]']));
  });

  it('mixes the diegetic branch with narration alone when there is no music', () => {
    const args = buildSummaryComposeArgs({
      spec: {
        ...SPEC,
        musicR2Key: null,
        diegeticWindows: [
          { startSec: 0, endSec: 3, sourceClipStartSec: 10, sourceClipEndSec: 13 },
        ],
      },
      sourcePath: '/tmp/source.mp4',
      narrationPath: '/tmp/narration.wav',
      musicPath: null,
      captionAssPath: '/tmp/captions.ass',
      fontsDir: '/tmp/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = args[args.indexOf('-filter_complex') + 1]!;

    expect(graph).toContain('[0:a]atrim=start=10:end=13,asetpts=PTS-STARTPTS,adelay=0|0[dieg0]');
    expect(graph).not.toContain('[bed]');
    expect(graph).toContain('[1:a][dieg0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]');
  });

  it('emits one atrim/adelay branch per window, in order, for a multi-window diegetic beat', () => {
    const args = buildSummaryComposeArgs({
      spec: {
        ...SPEC,
        diegeticWindows: [
          { startSec: 0, endSec: 2, sourceClipStartSec: 10, sourceClipEndSec: 12 },
          { startSec: 2, endSec: 4.5, sourceClipStartSec: 20, sourceClipEndSec: 22.5 },
        ],
      },
      sourcePath: '/tmp/source.mp4',
      narrationPath: '/tmp/narration.wav',
      musicPath: null,
      captionAssPath: '/tmp/captions.ass',
      fontsDir: '/tmp/fonts',
      outPath: '/tmp/out.mp4',
    });
    const graph = args[args.indexOf('-filter_complex') + 1]!;

    expect(graph).toContain('[0:a]atrim=start=10:end=12,asetpts=PTS-STARTPTS,adelay=0|0[dieg0]');
    expect(graph).toContain('[0:a]atrim=start=20:end=22.5,asetpts=PTS-STARTPTS,adelay=2000|2000[dieg1]');
    expect(graph).toContain('[1:a][dieg0][dieg1]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[aout]');
  });
});

describe('buildSummarySizingFilter', () => {
  it('letterboxes a 4:3 slice inside the square when framing is balanced', () => {
    const filter = buildSummarySizingFilter({ width: 1080, height: 1920, sourceFraming: 'balanced' });

    expect(filter).toContain(`crop='min(iw,ih*${4 / 3})':'min(ih,iw/${4 / 3})'`);
    expect(filter).toContain('scale=1080:1080:force_original_aspect_ratio=decrease');
    // Both the pad inside the square and the square inside the portrait canvas are centered.
    expect(filter).toContain('pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black');
    expect(filter).toContain('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black');
  });

  it('never crops when framing is fit', () => {
    const filter = buildSummarySizingFilter({ width: 1080, height: 1920, sourceFraming: 'fit' });

    expect(filter).not.toContain('crop');
    expect(filter).toContain('scale=1080:1080:force_original_aspect_ratio=decrease');
  });

  it('centers the square edit on a 1:1 canvas without adding a portrait pad', () => {
    const filter = buildSummarySizingFilter({ width: 1080, height: 1080, sourceFraming: 'balanced' });

    expect(filter).toContain('pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black');
    expect(filter).not.toContain('pad=1080:1920');
  });

  it('fills a 16:9 canvas edge to edge regardless of framing', () => {
    const filter = buildSummarySizingFilter({ width: 1920, height: 1080, sourceFraming: 'balanced' });

    expect(filter).toBe('scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080');
  });

  it('defaults to the full-bleed square crop when no framing is set', () => {
    expect(buildSummarySizingFilter({ width: 1080, height: 1920 }))
      .toContain('force_original_aspect_ratio=increase,crop=1080:1080');
  });
});
