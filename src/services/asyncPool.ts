/**
 * Bounded-concurrency pool: runs `worker(i)` for i in [0, count) with at most `limit` in flight at
 * once (a simple bank of self-refilling workers, not a batched chunk-of-N — a fast scene starts
 * its neighbor immediately rather than waiting for a whole batch to finish). Born as the fix for
 * the sequential explainer e2e's ~30min runtime (each scene was a fully serial TTS + still +
 * nano/gpt-stills + ffmpeg chain); ported into the production explainer worker 2026-07-25.
 * Per-scene results must be written BY INDEX inside `worker`, not push-order, since completion
 * order is nondeterministic under concurrency.
 */
export async function runPool(
  count: number,
  limit: number,
  worker: (i: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function lane(): Promise<void> {
    while (cursor < count) {
      const i = cursor;
      cursor += 1;
      await worker(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, count) }, () => lane()));
}
