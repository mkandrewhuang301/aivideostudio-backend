// Deterministic nano-edit budget allocator for the Illustrated tier's motion system
// (2026-07-23 nano-motion execution plan, Stage 5).
//
// The script LLM plans a motion per scene, but nano edits cost real money and the tier caps them
// at `edit_budget` (src/config/formats.ts FormatDurationTier.edit_budget). This allocator decides,
// deterministically and without any network calls, which scenes actually get to run their planned
// nano edits and which get downgraded to a free ffmpeg motion (see explainerVisualStage.ts for the
// downgrade mapping).
//
// Pure function — no I/O, easy to unit test exhaustively.

import { nanoCostOf, type ExplainerScene } from '../config/formats';

export interface AllocatedScene {
  sceneIndex: number;
  resolvedNano: boolean;
}

/**
 * Greedy allocation by priority DESC, then nano cost ASC, then sceneIndex ASC (deterministic
 * tie-break). A scene is granted nano only if its FULL edit_steps count fits within the remaining
 * budget — chains are never partially run. Free motions (ken_burns/wiggle, cost 0) always resolve
 * to `resolvedNano: false` since they never touch nano regardless of allocation.
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
