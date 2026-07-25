// Pure ffmpeg-arg builder tests for the nano-motion system (2026-07-23 execution plan, Stage 8).
// Mirrors the existing buildKenBurnsArgs/buildExplainerComposeArgs test style: assert on argv
// shape, filter-graph contents, and computed durations — never execute ffmpeg or hit any network.

jest.mock('../../config', () => ({
  config: {
    replicateApiToken: 'mock-token',
    geminiApiKey: 'mock-gemini-key',
    nanoImageModel: 'gemini-3.1-flash-image-preview',
  },
}));

import { buildWiggleArgs, buildMotionSequenceArgs, resolveMotionPlan, decorateStillPrompt } from '../../services/explainerVisualStage';
import type { SceneMotion } from '../../config/formats';

function motion(overrides: Partial<SceneMotion> = {}): SceneMotion {
  return { type: 'reaction', priority: 3, edit_steps: ['a change, keep everything else identical'], ...overrides };
}

describe('resolveMotionPlan (motion-class-aware fallback, 2026-07-23 design correction)', () => {
  it('no motion at all -> ken_burns', () => {
    expect(resolveMotionPlan(undefined, false)).toEqual({ kind: 'ken_burns' });
    expect(resolveMotionPlan(undefined, true)).toEqual({ kind: 'ken_burns' });
  });

  it('free types (ken_burns, wiggle) are unaffected by resolvedNano either way', () => {
    expect(resolveMotionPlan(motion({ type: 'ken_burns', edit_steps: [] }), false)).toEqual({ kind: 'ken_burns' });
    expect(resolveMotionPlan(motion({ type: 'ken_burns', edit_steps: [] }), true)).toEqual({ kind: 'ken_burns' });
    expect(resolveMotionPlan(motion({ type: 'wiggle', edit_steps: [] }), false)).toEqual({ kind: 'wiggle' });
    expect(resolveMotionPlan(motion({ type: 'wiggle', edit_steps: [] }), true)).toEqual({ kind: 'wiggle' });
  });

  it('any nano-eligible type takes the premium nano path when granted budget', () => {
    for (const type of ['reaction', 'before_after', 'ambient_life'] as const) {
      const m = motion({ type, edit_steps: ['step1'] });
      expect(resolveMotionPlan(m, true)).toEqual({ kind: 'nano', pattern: type, editSteps: ['step1'] });
    }
  });

  it("'semi' (reaction) unbudgeted degrades to wiggle — never static, never gpt_stills", () => {
    const m = motion({ type: 'reaction', edit_steps: ['character raises a hand, keep everything else identical'] });
    expect(resolveMotionPlan(m, false)).toEqual({ kind: 'wiggle' });
  });

  it("'decorative' (ambient_life) unbudgeted degrades to ken_burns — the only class that goes static", () => {
    const m = motion({ type: 'ambient_life', edit_steps: ['smoke drifts, keep everything else identical'] });
    expect(resolveMotionPlan(m, false)).toEqual({ kind: 'ken_burns' });
  });

  it("'content' (before_after) unbudgeted NEVER goes static — falls back to gpt_stills, not ken_burns/wiggle", () => {
    const beforeAfter = motion({ type: 'before_after', edit_steps: ['seed sprouts', 'sapling grows'] });
    expect(resolveMotionPlan(beforeAfter, false)).toEqual({
      kind: 'gpt_stills', pattern: 'before_after', editSteps: ['seed sprouts', 'sapling grows'],
    });
  });

  it('retired progressive_reveal (2026-07-23) is force-remapped to ken_burns regardless of resolvedNano — never nano, never gpt_stills, never chosen/rendered', () => {
    const m = motion({ type: 'progressive_reveal', priority: 5, edit_steps: ['label A appears', 'label B appears'] });
    expect(resolveMotionPlan(m, false)).toEqual({ kind: 'ken_burns' });
    expect(resolveMotionPlan(m, true)).toEqual({ kind: 'ken_burns' });
  });
});

describe('buildWiggleArgs', () => {
  it('loops the single still for exactly durationSeconds with a sine rotate filter', () => {
    const args = buildWiggleArgs({
      stillPath: '/tmp/still.png',
      durationSeconds: 5.5,
      aspectRatio: '9:16',
      outPath: '/tmp/out.mp4',
    });

    expect(args).toEqual(expect.arrayContaining(['-loop', '1', '-i', '/tmp/still.png']));
    const tIndex = args.indexOf('-t');
    expect(args[tIndex + 1]).toBe('5.5');

    const vfIndex = args.indexOf('-vf');
    const filter = args[vfIndex + 1]!;
    expect(filter).toContain('rotate=');
    expect(filter).toMatch(/sin\(2\*PI\*t\*/);
    expect(filter).toContain('setsar=1');
  });

  it('overscans before rotating so no canvas edge is exposed, then crops back to the target canvas', () => {
    const args = buildWiggleArgs({
      stillPath: '/tmp/still.png',
      durationSeconds: 4,
      aspectRatio: '16:9',
      outPath: '/tmp/out.mp4',
    });
    const filter = args[args.indexOf('-vf') + 1]!;

    // 16:9 canvas is 1920x1080 — the rotate stage must operate on an upscaled canvas larger than
    // that, and the final crop must bring it back to exactly 1920:1080.
    expect(filter).toMatch(/scale=\d+:\d+:force_original_aspect_ratio=increase/);
    expect(filter.match(/crop=1920:1080/g)).toHaveLength(1);
    const scaleMatch = filter.match(/scale=(\d+):(\d+)/);
    expect(Number(scaleMatch![1])).toBeGreaterThan(1920);
    expect(Number(scaleMatch![2])).toBeGreaterThan(1080);
  });

  it('produces a fixed argv array ending in the expected output options, no shell string', () => {
    const args = buildWiggleArgs({
      stillPath: '/tmp/still.png',
      durationSeconds: 3,
      aspectRatio: '9:16',
      outPath: '/tmp/out.mp4',
    });
    expect(args.some((arg) => arg.startsWith('ffmpeg '))).toBe(false);
    expect(args.slice(-5)).toEqual(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '/tmp/out.mp4']);
  });
});

function inputDurationsOf(args: string[]): number[] {
  const durations: number[] = [];
  args.forEach((arg, i) => {
    if (arg === '-t' && args[i + 2] === '-i') durations.push(Number(args[i + 1]));
  });
  return durations;
}

function filterComplexOf(args: string[]): string {
  const index = args.indexOf('-filter_complex');
  expect(index).toBeGreaterThan(-1);
  return args[index + 1]!;
}

describe('buildMotionSequenceArgs', () => {
  it('holds the single frame for the full duration when only one frame is given (no xfade)', () => {
    const args = buildMotionSequenceArgs({
      framePaths: ['/tmp/f0.png'],
      pattern: 'reaction',
      durationSeconds: 4,
      aspectRatio: '9:16',
      outPath: '/tmp/out.mp4',
    });
    expect(args).not.toContain('-filter_complex');
    expect(args).toEqual(expect.arrayContaining(['-loop', '1', '-i', '/tmp/f0.png']));
    expect(args[args.indexOf('-t') + 1]).toBe('4');
  });

  it('reaction (2 frames): ping-pongs A->B->A — two xfades, total duration equals durationSeconds', () => {
    const args = buildMotionSequenceArgs({
      framePaths: ['/tmp/f0.png', '/tmp/f1.png'],
      pattern: 'reaction',
      durationSeconds: 6,
      aspectRatio: '9:16',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);
    expect(graph.match(/xfade=/g)).toHaveLength(2);
    expect(graph.match(/duration=0.150000/g)).toHaveLength(2);

    const durations = inputDurationsOf(args);
    // A,B,A round trip = 3 inputs; total = sum(segDur) - (k-1)*cd must equal the requested duration.
    expect(durations).toHaveLength(3);
    const total = durations.reduce((a, b) => a + b, 0) - 2 * 0.15;
    expect(total).toBeCloseTo(6, 5);
    // frame A plays first AND last (round trip back to the base still)
    const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]!] : []));
    expect(inputs).toEqual(['/tmp/f0.png', '/tmp/f1.png', '/tmp/f0.png']);
  });

  it('before_after (3 frames): plays LINEARLY (no ping-pong) — two chained xfades, 0.2s crossfades', () => {
    const args = buildMotionSequenceArgs({
      framePaths: ['/tmp/f0.png', '/tmp/f1.png', '/tmp/f2.png'],
      pattern: 'before_after',
      durationSeconds: 9,
      aspectRatio: '9:16',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);
    expect(graph.match(/xfade=/g)).toHaveLength(2);
    expect(graph.match(/duration=0.200000/g)).toHaveLength(2);

    const durations = inputDurationsOf(args);
    expect(durations).toHaveLength(3);
    // total output = sum(segDur) - (k-1)*cd
    const total = durations.reduce((a, b) => a + b, 0) - 2 * 0.2;
    expect(total).toBeCloseTo(9, 5);
    // roughly equal thirds
    durations.forEach((d) => expect(d).toBeCloseTo(durations[0]!, 5));
    // linear playback: inputs are exactly the given frames, no round-trip duplicates
    const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]!] : []));
    expect(inputs).toEqual(['/tmp/f0.png', '/tmp/f1.png', '/tmp/f2.png']);
  });

  it('progressive_reveal (up to 4 frames): N-1 xfades with 0.1s fades, exact total duration', () => {
    const args = buildMotionSequenceArgs({
      framePaths: ['/tmp/f0.png', '/tmp/f1.png', '/tmp/f2.png', '/tmp/f3.png'],
      pattern: 'progressive_reveal',
      durationSeconds: 8,
      aspectRatio: '16:9',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);
    expect(graph.match(/xfade=/g)).toHaveLength(3);
    expect(graph.match(/duration=0.100000/g)).toHaveLength(3);

    const durations = inputDurationsOf(args);
    const total = durations.reduce((a, b) => a + b, 0) - 3 * 0.1;
    expect(total).toBeCloseTo(8, 5);
  });

  it('ambient_life (2 frames): ping-pongs A->B->A with two slow 0.5s crossfades', () => {
    const args = buildMotionSequenceArgs({
      framePaths: ['/tmp/f0.png', '/tmp/f1.png'],
      pattern: 'ambient_life',
      durationSeconds: 7.5, // long enough that the 0.5s crossfade survives the per-segment clamp
      aspectRatio: '9:16',
      outPath: '/tmp/out.mp4',
    });
    const graph = filterComplexOf(args);
    expect(graph.match(/xfade=/g)).toHaveLength(2);
    expect(graph.match(/duration=0.500000/g)).toHaveLength(2);

    const durations = inputDurationsOf(args);
    expect(durations).toHaveLength(3);
    const total = durations.reduce((a, b) => a + b, 0) - 2 * 0.5;
    expect(total).toBeCloseTo(7.5, 5);
  });

  it('clamps the crossfade duration down for a very short scene so segments never go negative', () => {
    const args = buildMotionSequenceArgs({
      framePaths: ['/tmp/f0.png', '/tmp/f1.png', '/tmp/f2.png'],
      pattern: 'ambient_life', // configured cd=0.5, would be too large for a 1s/3-frame scene
      durationSeconds: 1,
      aspectRatio: '9:16',
      outPath: '/tmp/out.mp4',
    });
    const durations = inputDurationsOf(args);
    durations.forEach((d) => expect(d).toBeGreaterThan(0));
    const graph = filterComplexOf(args);
    expect(graph).not.toContain('duration=0.500000');
  });

  it('maps the final xfade output to [vout] and never emits a shell command string', () => {
    const args = buildMotionSequenceArgs({
      framePaths: ['/tmp/f0.png', '/tmp/f1.png'],
      pattern: 'reaction',
      durationSeconds: 4,
      aspectRatio: '9:16',
      outPath: '/tmp/out.mp4',
    });
    expect(args).toEqual(expect.arrayContaining(['-map', '[vout]']));
    expect(args.some((arg) => arg.startsWith('ffmpeg '))).toBe(false);
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[vout]');
  });
});

describe('decorateStillPrompt (on_image_text, 2026-07-25)', () => {
  const scene = 'a 1901 Wright brothers wooden wind tunnel in a gas-lit workshop';

  it('forbids all text when onImageText is absent, null-ish, or blank', () => {
    for (const value of [undefined, ''] as const) {
      const prompt = decorateStillPrompt(scene, value, 'lower_third');
      expect(prompt).toContain(scene);
      expect(prompt).toContain('No text, words, letters, or numbers anywhere in the image.');
      expect(prompt).not.toContain('TEXT:');
    }
  });

  it('requests the exact string legibly and steers it away from the caption zone', () => {
    const prompt = decorateStillPrompt(scene, 'KITTY HAWK', 'lower_third');
    expect(prompt).toContain('"KITTY HAWK"');
    expect(prompt).toContain('away from the lower third of the frame');
    expect(prompt).toContain('No other words, letters, or numbers anywhere.');
    expect(prompt).not.toContain('No text, words, letters, or numbers anywhere in the image.');
  });

  it('maps every text_zone to readable phrasing (default lower_third)', () => {
    expect(decorateStillPrompt(scene, '1903', 'upper_third')).toContain('away from the upper third');
    expect(decorateStillPrompt(scene, '1903', 'center')).toContain('away from the center');
    expect(decorateStillPrompt(scene, '1903')).toContain('away from the lower third');
  });

  it('trims surrounding whitespace from the requested string', () => {
    expect(decorateStillPrompt(scene, '  1903  ', 'center')).toContain('"1903"');
  });
});
