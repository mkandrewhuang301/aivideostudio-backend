// Wave-0 spike (2026-07-20): answer three questions before touching the Explainer pipeline.
//
//   Q1  Does `google/gemini-omni-flash/reference-to-video` exist and accept a style anchor as
//       <IMAGE_REF_0> (a style reference, NOT a forced first frame)?
//   Q-stills  Do we even need per-scene stills? Compare the SAME scene rendered 3 ways:
//         (a) i2v  — current path: a real first-frame still  -> google/gemini-omni-flash/image-to-video
//         (b) ref  — style anchor as <IMAGE_REF_0> + prompt  -> google/gemini-omni-flash/reference-to-video
//         (c) t2v  — prompt only, no image at all           -> google/gemini-omni-flash
//   Q-consistency  Render 2 consecutive scenes for `ref` (shared anchor) and `t2v` (no anchor)
//       so a human can eyeball whether style drifts across scenes without per-scene stills.
//
// This ONLY produces clip URLs + latency/output-shape data. A human must watch the clips to
// judge style/consistency — that is the whole point of the stills question.
//
// Run:  cd ~/aivideostudio-backend
//       npx tsx src/scripts/spikeOmni.ts <mode>
//   modes: matrix (default) | ref | t2v | i2v | consistency
//   env:  FAL_KEY (from .env), SPIKE_ANCHOR_URL (optional; swap in a real style-anchor image)

import 'dotenv/config';
import { fal } from '@fal-ai/client';

const REF_MODEL = 'google/gemini-omni-flash/reference-to-video';
const I2V_MODEL = 'google/gemini-omni-flash/image-to-video';
const T2V_MODEL = 'google/gemini-omni-flash';

// A photo by default — swap SPIKE_ANCHOR_URL for a real flat-illustration anchor to judge STYLE
// adoption properly. Any publicly fetchable URL works; fal fetches it server-side.
const ANCHOR_URL =
  process.env.SPIKE_ANCHOR_URL ?? 'https://picsum.photos/seed/explainer-anchor/1024/1024';

const ASPECT = '16:9' as const;
const DURATION = 6;

// Two consecutive explainer scenes (photosynthesis), written so a shared style should be obvious.
const SCENES = [
  'a single green leaf on a plant, warm morning sunlight streaming onto it, gentle slow camera push-in',
  'a cross-section diagram of a leaf cell with tiny green chloroplasts glowing, soft parallax drift',
];

type RunResult = { label: string; url: string | null; ms: number; error?: string };

async function subscribeForVideo(label: string, model: string, input: Record<string, unknown>): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const result = (await fal.subscribe(model, { input })) as { data?: { video?: { url?: unknown } } };
    const url = result?.data?.video?.url;
    const ms = Date.now() - t0;
    if (typeof url !== 'string' || !url) {
      return { label, url: null, ms, error: `no video.url in output: ${JSON.stringify(result?.data)?.slice(0, 300)}` };
    }
    return { label, url, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    const e = err as { status?: unknown; body?: unknown; message?: unknown };
    const detail = e?.body ? JSON.stringify(e.body).slice(0, 400) : String(e?.message ?? err);
    return { label, url: null, ms, error: `status=${String(e?.status ?? '?')} ${detail}` };
  }
}

function refPrompt(scenePrompt: string): string {
  // reference-to-video: the tag pins the anchor as a STYLE reference, not the first frame.
  return `In the exact art style of <IMAGE_REF_0>, show ${scenePrompt}.`;
}

async function runI2v(scenePrompt: string, tag: string) {
  return subscribeForVideo(`i2v ${tag}`, I2V_MODEL, {
    prompt: scenePrompt,
    image_url: ANCHOR_URL,
    aspect_ratio: ASPECT,
    duration: DURATION,
  });
}

async function runRef(scenePrompt: string, tag: string) {
  return subscribeForVideo(`ref ${tag}`, REF_MODEL, {
    prompt: refPrompt(scenePrompt),
    image_urls: [ANCHOR_URL],
    aspect_ratio: ASPECT,
    duration: DURATION,
  });
}

async function runT2v(scenePrompt: string, tag: string) {
  return subscribeForVideo(`t2v ${tag}`, T2V_MODEL, {
    prompt: scenePrompt,
    aspect_ratio: ASPECT,
    duration: DURATION,
  });
}

function report(results: RunResult[]) {
  console.log('\n================ SPIKE RESULTS ================');
  for (const r of results) {
    if (r.url) {
      console.log(`✅ ${r.label.padEnd(16)} ${(r.ms / 1000).toFixed(1)}s  ${r.url}`);
    } else {
      console.log(`❌ ${r.label.padEnd(16)} ${(r.ms / 1000).toFixed(1)}s  ERROR: ${r.error}`);
    }
  }
  console.log('==============================================\n');
  console.log('Anchor used:', ANCHOR_URL);
  console.log('Watch the clips and judge: (1) does `ref` adopt the anchor style? (2) do the two');
  console.log('`ref` scenes look like the same world? (3) do the two `t2v` scenes drift apart?\n');
}

async function main() {
  if (!process.env.FAL_KEY) {
    console.error('FAL_KEY missing — cannot run. Check .env.');
    process.exit(1);
  }
  fal.config({ credentials: process.env.FAL_KEY });

  const mode = process.argv[2] ?? 'matrix';
  const results: RunResult[] = [];

  if (mode === 'ref') {
    results.push(await runRef(SCENES[0]!, 'scene0'));
  } else if (mode === 't2v') {
    results.push(await runT2v(SCENES[0]!, 'scene0'));
  } else if (mode === 'i2v') {
    results.push(await runI2v(SCENES[0]!, 'scene0'));
  } else if (mode === 'consistency') {
    // Render 2 scenes each for ref (shared anchor) and t2v (no anchor).
    results.push(await runRef(SCENES[0]!, 'scene0'));
    results.push(await runRef(SCENES[1]!, 'scene1'));
    results.push(await runT2v(SCENES[0]!, 'scene0'));
    results.push(await runT2v(SCENES[1]!, 'scene1'));
  } else {
    // matrix: same scene, all three modes — the core "do we need stills" comparison.
    results.push(await runI2v(SCENES[0]!, 'scene0'));
    results.push(await runRef(SCENES[0]!, 'scene0'));
    results.push(await runT2v(SCENES[0]!, 'scene0'));
  }

  report(results);
}

main().catch((err) => {
  console.error('Spike crashed:', err);
  process.exit(1);
});
