// Deterministic nano-edit budget allocator for the Illustrated tier's motion system
// (2026-07-23 nano-motion execution plan, Stage 5; revised same-day per the motion-class design
// correction — see SceneMotionClass in ../config/formats.ts).
//
// The script LLM plans a motion per scene, but nano (pixel-preserving) edits cost real money and
// the tier caps them at `edit_budget` (src/config/formats.ts FormatDurationTier.edit_budget). This
// allocator decides, deterministically and without any network calls, which scenes get the
// PREMIUM pixel-locked nano version of their motion vs the cheaper fallback.
//
// IMPORTANT: edit_budget does NOT decide whether a scene's transformation happens — only whether
// it gets nano's pixel-preservation. A scene that isn't granted (`resolvedNano: false`) still
// fully renders its motion; explainerVisualStage.ts picks the fallback per motion CLASS:
//   - 'content' (before_after, progressive_reveal): independent gpt stills per step — the
//     transformation still shows, just not pixel-locked. Never goes static.
//   - 'semi' (reaction): degrades to wiggle. 'decorative' (ambient_life): degrades to ken_burns.
// Only ungranted scenes ever fall back this way, and only granted scenes ever consume budget —
// declining a candidate here never charges it, regardless of what fallback the stage later picks.
//
// Pure function — no I/O, easy to unit test exhaustively.

import { nanoCostOf, type ExplainerScene } from '../config/formats';

export interface AllocatedScene {
  sceneIndex: number;
  /** True = this scene's nano motion type was granted the premium pixel-locked nano path. */
  resolvedNano: boolean;
}

/**
 * Greedy allocation by priority DESC, then nano cost ASC, then sceneIndex ASC (deterministic
 * tie-break). A scene is granted nano only if its FULL edit_steps count fits within the remaining
 * budget — chains are never partially run. Free motions (ken_burns/wiggle, cost 0) always resolve
 * to `resolvedNano: false` since they never touch nano regardless of allocation. An ungranted
 * candidate never reduces `remaining` — declining costs nothing, whatever fallback the stage picks.
 */
export function allocateMotionBudget(
  scenes: ExplainerScene[],
  editBudget: number,
): AllocatedScene[] {
  const safeBudget = Math.max(0, editBudget);

  const candidates = scenes.map((scene, sceneIndex) => ({
    sceneIndex,
    cost: nanoCostOf(scene),
    priority: scene.motion?.priority ?? 1,
  }));

  const order = [...candidates].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority; // priority DESC
    if (a.cost !== b.cost) return a.cost - b.cost; // cost ASC
    return a.sceneIndex - b.sceneIndex; // sceneIndex ASC
  });

  const granted = new Set<number>();
  let remaining = safeBudget;
  for (const candidate of order) {
    if (candidate.cost === 0) continue; // free motion, never consumes budget or needs granting
    if (candidate.cost <= remaining) {
      granted.add(candidate.sceneIndex);
      remaining -= candidate.cost;
    }
  }

  return candidates
    .map(({ sceneIndex, cost }) => ({
      sceneIndex,
      resolvedNano: cost > 0 && granted.has(sceneIndex),
    }))
    .sort((a, b) => a.sceneIndex - b.sceneIndex);
}
