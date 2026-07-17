// Phase 14 Plan 05: pure argv/filter-graph contracts for pre-animated Explainer assembly.

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

import type { ExplainerComposeSpec } from '../../queue/ffmpegWorker';
import { buildExplainerComposeArgs } from '../../queue/ffmpegProcessor';
import { buildAssFile, escapeAssText } from '../../services/assCaptionBuilder';

function baseSpec(overrides: Partial<ExplainerComposeSpec> = {}): ExplainerComposeSpec {
  return {
    width: 1080,
    height: 1920,
    fps: 25,
    clips: [
      { r2Key: 'generations/g1.scene0.mp4', durationSeconds: 4.125 },
      { r2Key: 'generations/g1.scene1.mp4', durationSeconds: 6.75 },
    ],
    narrationR2Key: 'generations/g1.narration.wav',
    musicR2Key: null,
    musicVolume: 0.18,
    captionCues: [
      { startSeconds: 0, endSeconds: 1, words: [{ text: 'Hello', startSeconds: 0, endSeconds: 1 }] },
    ],
    captionStyle: { fontSize: 44, color: '#FFFFFF', highlightColor: '#FFD60A', position: 'bottom' },
    ...overrides,
  };
}

function buildArgs(spec = baseSpec(), paths: Partial<{
  clipPaths: string[];
  narrationPath: string;
  musicPath: string | null;
  captionAssPath: string;
  fontsDir: string;
  outPath: string;
}> = {}): string[] {
  return buildExplainerComposeArgs({
    spec,
    clipPaths: ['/tmp/clip0.mp4', '/tmp/clip1.mp4'],
    narrationPath: '/tmp/narration.wav',
    musicPath: null,
    captionAssPath: '/tmp/captions.ass',
    fontsDir: '/app/assets/fonts',
    outPath: '/tmp/out.mp4',
    ...paths,
  });
}

function filterComplexOf(args: string[]): string {
  const index = args.indexOf('-filter_complex');
  expect(index).toBeGreaterThan(-1);
  return args[index + 1];
}

function mapTargetsOf(args: string[]): string[] {
  return args.flatMap((arg, index) => arg === '-map' ? [args[index + 1]] : []);
}

describe('buildExplainerComposeArgs', () => {
  it('input-trims every Omni clip to its exact narration duration and never references native audio', () => {
    const args = buildArgs();
    const graph = filterComplexOf(args);

    const firstInput = args.indexOf('/tmp/clip0.mp4');
    const secondInput = args.indexOf('/tmp/clip1.mp4');
    expect(args.slice(firstInput - 3, firstInput + 1)).toEqual(['-t', '4.125', '-i', '/tmp/clip0.mp4']);
    expect(args.slice(secondInput - 3, secondInput + 1)).toEqual(['-t', '6.75', '-i', '/tmp/clip1.mp4']);
    expect(graph).toContain('[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v0]');
    expect(graph).toContain('[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v1]');
    expect(graph).not.toContain('[0:a]');
    expect(graph).not.toContain('[1:a]');
  });

  it('concatenates the normalized clip video labels exactly once with audio disabled', () => {
    const graph = filterComplexOf(buildArgs());

    expect(graph).toContain('[v0][v1]concat=n=2:v=1:a=0[vconcat]');
    expect(graph.match(/concat=n=/g)).toHaveLength(1);
  });

  it('maps narration directly without music and loops, lowers, and mixes an optional music bed', () => {
    const narrationOnlyArgs = buildArgs();
    const narrationOnlyGraph = filterComplexOf(narrationOnlyArgs);
    expect(narrationOnlyGraph).not.toContain('amix=');
    expect(narrationOnlyGraph).not.toContain('volume=');
    expect(mapTargetsOf(narrationOnlyArgs)).toEqual(['[vout]', '2:a']);

    const musicSpec = baseSpec({ musicR2Key: 'generations/g1.music.wav' });
    const withMusicArgs = buildArgs(musicSpec, { musicPath: '/tmp/music.wav' });
    const withMusicGraph = filterComplexOf(withMusicArgs);
    const musicInput = withMusicArgs.indexOf('/tmp/music.wav');
    expect(withMusicArgs.slice(musicInput - 3, musicInput + 1)).toEqual(['-stream_loop', '-1', '-i', '/tmp/music.wav']);
    expect(withMusicGraph).toContain('[3:a]volume=0.18[bed]');
    expect(withMusicGraph).toContain('[2:a][bed]amix=inputs=2:duration=first:dropout_transition=0[aout]');
    expect(mapTargetsOf(withMusicArgs)).toEqual(['[vout]', '[aout]']);
  });

  it('burns exactly one caller-supplied caption ASS file after the video concat', () => {
    const graph = filterComplexOf(buildArgs());

    expect(graph).toContain('[vconcat]ass=filename=/tmp/captions.ass:fontsdir=/app/assets/fonts[vout]');
    expect(graph.match(/ass=filename=/g)).toHaveLength(1);
    expect(graph).not.toMatch(/title|textOverlay/i);
  });

  it('keeps caption content on the existing buildAssFile and escapeAssText path', () => {
    const unsafe = '{\\pos(0,0)}Hello';
    const ass = buildAssFile(
      [{ startSeconds: 0, endSeconds: 1, words: [{ text: unsafe, startSeconds: 0, endSeconds: 1 }] }],
      baseSpec().captionStyle,
      { width: 1080, height: 1920 },
    );
    expect(ass).toContain(escapeAssText(unsafe));
    expect(ass).not.toContain('{\\pos(0,0)}');

    const graph = filterComplexOf(buildArgs(baseSpec(), { captionAssPath: '/tmp/caller-wrote-this.ass' }));
    expect(graph.match(/caller-wrote-this\.ass/g)).toHaveLength(1);
    expect(graph).not.toContain('Dialogue:');
  });

  it('returns a fixed argv array with the whole filter graph in one element and no shell command string', () => {
    const args = buildArgs(baseSpec(), {
      clipPaths: ['/tmp/clip zero.mp4', "/tmp/clip'one.mp4"],
      captionAssPath: '/tmp/captions file.ass',
    });
    const filterIndex = args.indexOf('-filter_complex');

    expect(args.filter((arg) => arg === '-filter_complex')).toHaveLength(1);
    expect(args[filterIndex + 1]).toBe(filterComplexOf(args));
    expect(args).toContain('/tmp/clip zero.mp4');
    expect(args).toContain("/tmp/clip'one.mp4");
    expect(args.some((arg) => arg.startsWith('ffmpeg '))).toBe(false);
    expect(args.slice(-7)).toEqual(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '/tmp/out.mp4']);
  });
});
