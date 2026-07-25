// SPIKE (throwaway) — Fruit Island A/B: cheap dialogue models for the dating-show format.
//   Arm A: google/veo-3.1-lite  ($0.05/s @720p → $0.40 for 8s)
//   Arm B: bytedance/seedance-2.0-mini (current Create basic tier, ~$0.35 for 8s)
// Same start frame (Andrew's IMG_7896 — mango guy + cherry girl, tropical bar), same 2-voice
// banter script, 8s, 720p, 16:9. Judges: can the CHEAP models do 2-speaker lip-synced banter
// well enough that Fruit Island doesn't need Kling O3? (O3 = current 7/24 routing, pricey.)
//
// Script is hand-sized to ~8s at ~2.5 w/s — the planner-brain (AutoExplainer-style) comes later;
// this spike judges the render tier only. Veo caps at 8s, so 8s both arms for like-for-like.
//
// Run:  cd ~/aivideostudio-backend && npx tsx src/scripts/spikeFruitIslandAB.ts
// env:  REPLICATE_API_TOKEN (from .env)
// cost: ~$0.75 total

import 'dotenv/config';
import Replicate from 'replicate';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = `${process.env.HOME}/Downloads/spike-fruit-island-ab`;
const FRAME = `${process.env.HOME}/Downloads/IMG_7896.png`;

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const VEO = 'google/veo-3.1-lite';
const SEEDANCE = 'bytedance/seedance-2.0-mini';
const DURATION = 8; // Veo hard cap
const RES = '720p';
const ASPECT = '16:9';

const CHERRY_LINE = 'So... are you actually here for love, or just the cocktails?';
const MANGO_LINE = 'I was gonna say love — but you just handed me a drink.';

const SCENE = 'Romantic reality dating-show scene at a tropical beach bar at sunset, neon ring '
  + 'lights, warm cinematic lighting, shallow depth of field. A muscular young man with a mango '
  + 'for a head and green leafy hair, open Hawaiian shirt, sits on a couch beside a young woman '
  + 'with a cherry for a head and a stem with leaves, pink sundress, holding a pink cocktail.';

const VEO_PROMPT = `${SCENE} The cherry woman turns to the mango man and asks flirtatiously: `
  + `"${CHERRY_LINE}" The mango man grins and replies smoothly: "${MANGO_LINE}" `
  + 'Natural lip-sync, expressive faces, reality-TV confessional energy. '
  + 'No subtitles, no on-screen text, no captions.';

// Verbatim lock (lessons discipline): exact words, nothing else.
const SEEDANCE_PROMPT = `${SCENE} The cherry woman turns to the mango man and says these exact `
  + `words and nothing else: "${CHERRY_LINE}". The mango man grins and replies with these exact `
  + `words and nothing else: "${MANGO_LINE}". The spoken audio must match both lines verbatim.`;

function toUrl(o: unknown): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v && typeof (v as { url?: unknown }).url === 'function') return String((v as { url: () => unknown }).url());
  if (v && (v as { url?: unknown }).url) return String((v as { url: unknown }).url);
  throw new Error('replicate: no output url');
}

async function download(url: string, name: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${name} → ${r.status}`);
  const path = `${OUT}/${name}`;
  writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  return path;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const out = await fn();
  console.log(`  ${label} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return out;
}

// Retries the known-transient ReadError (mirrors production withReplicateRetry).
async function runWithRetry(label: string, model: `${string}/${string}`, input: Record<string, unknown>): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return toUrl(await replicate.run(model, { input: input as never }));
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      if (!/ReadError|ECONNRESET|timeout|throttled|Too Many Requests|429|502|503|504/i.test(msg)) throw e;
      const wait = /429|throttled/i.test(msg) ? 12000 : 3000 * attempt;
      console.log(`  ${label} transient (attempt ${attempt}/4): ${msg.slice(0, 90)} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const frame = readFileSync(FRAME);
  console.log(`Frame: ${FRAME}`);
  console.log(`Script (~${Math.round((CHERRY_LINE.split(' ').length + MANGO_LINE.split(' ').length) / 2.5)}s est):`);
  console.log(`  CHERRY: "${CHERRY_LINE}"`);
  console.log(`  MANGO:  "${MANGO_LINE}"`);

  console.log('\nDispatching both arms concurrently…');
  const [veo, seed] = await Promise.allSettled([
    timed('Veo 3.1 Lite', () => runWithRetry('Veo', VEO, {
      image: frame,
      prompt: VEO_PROMPT,
      duration: DURATION,
      resolution: RES,
      aspect_ratio: ASPECT,
    })),
    timed('Seedance Mini', () => runWithRetry('Seedance', SEEDANCE, {
      prompt: `${SEEDANCE_PROMPT} [Image1]`,
      reference_images: [frame],
      duration: DURATION,
      resolution: RES,
      aspect_ratio: ASPECT,
      generate_audio: true,
    })),
  ]);

  console.log('\n=== RESULTS ===');
  if (veo.status === 'fulfilled') {
    const p = await download(veo.value, 'fruit_A_veo31lite.mp4');
    console.log(`A) Veo 3.1 Lite  : ${p}\n   url: ${veo.value}`);
  } else {
    console.log(`A) Veo 3.1 Lite  : FAILED — ${veo.reason?.message ?? veo.reason}`);
  }
  if (seed.status === 'fulfilled') {
    const p = await download(seed.value, 'fruit_B_seedanceMini.mp4');
    console.log(`B) Seedance Mini : ${p}\n   url: ${seed.value}`);
  } else {
    console.log(`B) Seedance Mini : FAILED — ${seed.reason?.message ?? seed.reason}`);
  }
}

main().catch((e) => {
  console.error('spike failed:', e);
  process.exit(1);
});
