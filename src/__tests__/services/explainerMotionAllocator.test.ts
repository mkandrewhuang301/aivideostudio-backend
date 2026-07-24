import { allocateMotionBudget } from '../../services/explainerMotionAllocator';
import type { ExplainerScene } from '../../config/formats';

function scene(overrides: Partial<ExplainerScene> = {}): ExplainerScene {
  return {
    visual_prompt: 'a scene',
    motion_prompt: 'gentle push-in',
    narration_line: 'Some narration.',
    text_zone: 'lower_third',
    segment_type: 'dialogue',
    ...overrides,
  };
}

function nanoScene(type: 'reaction' | 'before_after' | 'progressive_reveal' | 'ambient_life', priority: number, editStepCount: number): ExplainerScene {
  return scene({
    motion: { type, priority, edit_steps: Array.from({ length: editStepCount }, (_, i) => `step ${i}`) },
  });
}

function freeScene(type: 'ken_burns' | 'wiggle', priority = 2): ExplainerScene {
  return scene({ motion: { type, priority, edit_steps: [] } });
}

describe('allocateMotionBudget', () => {
  it('returns empty allocation for empty scene list', () => {
    expect(allocateMotionBudget([], 4)).toEqual([]);
  });

  it('grants nothing when every scene is a free motion (cost 0)', () => {
    const scenes = [freeScene('ken_burns'), freeScene('wiggle')];
    const result = allocateMotionBudget(scenes, 4);
    expect(result).toEqual([
      { sceneIndex: 0, resolvedNano: false },
      { sceneIndex: 1, resolvedNano: false },
    ]);
  });

  it('grants every nano scene when the exact total cost fits the budget', () => {
    // reaction=1, before_after=2 -> total 3, budget 3
    const scenes = [nanoScene('reaction', 3, 1), nanoScene('before_after', 3, 2)];
    const result = allocateMotionBudget(scenes, 3);
    expect(result).toEqual([
      { sceneIndex: 0, resolvedNano: true },
      { sceneIndex: 1, resolvedNano: true },
    ]);
  });

  it('downgrades the lowest-priority scenes first when over budget', () => {
    const scenes = [
      nanoScene('reaction', 5, 1),          // sceneIndex 0, priority 5, cost 1
      nanoScene('before_after', 2, 2),      // sceneIndex 1, priority 2, cost 2 (lowest priority)
      nanoScene('progressive_reveal', 4, 2), // sceneIndex 2, priority 4, cost 2
    ];
    // total cost = 5, budget = 3 -> only priority 5 (cost1) and priority 4 (cost2) fit = 3 exactly
    const result = allocateMotionBudget(scenes, 3);
    expect(result).toEqual([
      { sceneIndex: 0, resolvedNano: true },  // priority 5 granted
      { sceneIndex: 1, resolvedNano: false }, // priority 2 downgraded (lowest priority)
      { sceneIndex: 2, resolvedNano: true },  // priority 4 granted
    ]);
  });

  it('never partially grants a chain — a scene only fits WHOLE within remaining budget', () => {
    // budget 2; scene0 priority 5 cost 1 granted (remaining 1); scene1 priority 4 cost 2 doesn't
    // fit in remaining 1, so it's fully downgraded, not run for 1 of its 2 steps.
    const scenes = [nanoScene('reaction', 5, 1), nanoScene('before_after', 4, 2)];
    const result = allocateMotionBudget(scenes, 2);
    expect(result).toEqual([
      { sceneIndex: 0, resolvedNano: true },
      { sceneIndex: 1, resolvedNano: false },
    ]);
  });

  it('is deterministic: ties break by lower cost then lower sceneIndex', () => {
    const scenes = [
      nanoScene('progressive_reveal', 3, 2), // sceneIndex 0, priority 3, cost 2
      nanoScene('reaction', 3, 1),           // sceneIndex 1, priority 3, cost 1 (same priority, lower cost)
      nanoScene('ambient_life', 3, 1),       // sceneIndex 2, priority 3, cost 1 (same priority+cost, higher index)
    ];
    // budget 2: order by cost ASC among same priority = sceneIndex1(cost1), sceneIndex2(cost1), sceneIndex0(cost2)
    // grant sceneIndex1 (remaining 1), grant sceneIndex2 (remaining 0), sceneIndex0 doesn't fit.
    const result = allocateMotionBudget(scenes, 2);
    expect(result).toEqual([
      { sceneIndex: 0, resolvedNano: false },
      { sceneIndex: 1, resolvedNano: true },
      { sceneIndex: 2, resolvedNano: true },
    ]);
  });

  it('treats a missing motion field as cost 0 (never granted, never downgraded)', () => {
    const scenes = [scene(), nanoScene('reaction', 3, 1)];
    const result = allocateMotionBudget(scenes, 5);
    expect(result).toEqual([
      { sceneIndex: 0, resolvedNano: false },
      { sceneIndex: 1, resolvedNano: true },
    ]);
  });

  it('grants nothing when budget is 0, regardless of priority', () => {
    const scenes = [nanoScene('reaction', 5, 1)];
    const result = allocateMotionBudget(scenes, 0);
    expect(result).toEqual([{ sceneIndex: 0, resolvedNano: false }]);
  });

  it('clamps a negative budget to 0 rather than granting anything', () => {
    const scenes = [nanoScene('reaction', 5, 1)];
    const result = allocateMotionBudget(scenes, -3);
    expect(result).toEqual([{ sceneIndex: 0, resolvedNano: false }]);
  });

  // 2026-07-23 design correction: content-class scenes (before_after/progressive_reveal) that
  // don't win nano budget still fully render (via the stage's gpt-stills fallback) — but that
  // fallback must never be charged against edit_budget. Declining a candidate here always costs
  // nothing, regardless of what the stage later does with an ungranted scene.
  it('an ungranted content-class scene consumes no budget, leaving it for a later, lower-priority scene', () => {
    const scenes = [
      nanoScene('before_after', 1, 3), // sceneIndex 0: low priority, expensive (cost 3) -> won't fit
      nanoScene('reaction', 2, 1),     // sceneIndex 1: higher priority, cheap (cost 1)
    ];
    // budget 1: before_after (cost 3) can't fit even though tried first by cost... actually
    // priority DESC puts reaction (priority 2) first, granting its cost-1; before_after (priority
    // 1, cost 3) never fits in the remaining 0. Confirms the decline costs nothing further.
    const result = allocateMotionBudget(scenes, 1);
    expect(result).toEqual([
      { sceneIndex: 0, resolvedNano: false }, // before_after declined — still renders via gpt_stills in the stage, for free here
      { sceneIndex: 1, resolvedNano: true },
    ]);
  });

  it('mixes all four nano-eligible classes and still allocates purely by priority/cost, independent of class', () => {
    const scenes = [
      nanoScene('before_after', 3, 2),       // content, cost 2
      nanoScene('reaction', 3, 1),           // semi, cost 1
      nanoScene('progressive_reveal', 3, 2), // content, cost 2
      nanoScene('ambient_life', 3, 1),       // decorative, cost 1
    ];
    // All same priority; cost ASC tiebreak orders: reaction(1), ambient_life(1), before_after(2), progressive_reveal(2).
    // budget 2: grant reaction (remaining 1), grant ambient_life (remaining 0), the two cost-2 content scenes decline.
    const result = allocateMotionBudget(scenes, 2);
    expect(result).toEqual([
      { sceneIndex: 0, resolvedNano: false },
      { sceneIndex: 1, resolvedNano: true },
      { sceneIndex: 2, resolvedNano: false },
      { sceneIndex: 3, resolvedNano: true },
    ]);
  });
});
