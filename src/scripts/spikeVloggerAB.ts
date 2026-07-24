// A/B: gorilla-vlogger character through Seedance-2.0-mini (audio-on ref-to-video, current
// gorilla-vlogs production path) vs Kling O3 reference-to-video ("omni reference" / character
// elements + native lip-sync). Same generated character image + same expanded dialogue, one
// short vertical clip each, so the two can be eyeballed side by side.
//
// Run:  cd ~/aivideostudio-backend && npx tsx src/scripts/spikeVloggerAB.ts
// env:  OPENAI_API_KEY, REPLICATE_API_TOKEN, FAL_KEY (all from .env)
// cost: ~$0.02 gpt-image-2 + ~$0.22 Seedance-mini 720p 5s + ~$0.56 Kling O3 audio-on 5s ≈ $0.80

import 'dotenv/config';
import Replicate from 'replicate';
import { fal } from '@fal-ai/client';
import { writeFileSync } from 'node:fs';
import { expandScript } from '../services/openaiScriptService';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/32cfd4f3-c7a4-443e-8742-9963bfb76b2a/scratchpad';
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
fal.config({ credentials: process.env.FAL_KEY });

const SEEDANCE = 'bytedance/seedance-2.0-mini';
const KLING = 'fal-ai/kling-video/o3/standard/reference-to-video';
const DURATION = 6;
const ASPECT = '9:16';

// Spoken line sized to ~6s of natural speech (~14 words @ ~2.5 wps) so neither model has to
// cram — the point of this regen is judging model quality at a natural pace, not the expander.
const SPOKEN = "Look at this whole crate of bananas — I'm shaking! Full taste test, let's go!";
const PROMPT = `Selfie-cam vlog, handheld phone at arm's length, casual upbeat energy. `
  + `The character grins at the camera and excitedly says: "${SPOKEN}"`;

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

async function genGorilla(): Promise<string> {
  const out = await replicate.run('openai/gpt-image-2', {
    input: {
      prompt:
        'A friendly cartoon gorilla influencer taking a selfie-style vlog portrait, holding a '
        + 'phone at arm’s length, expressive happy face, casual colorful hoodie, soft indoor '
        + 'lighting, vertical 9:16 framing, clean simple bedroom background',
      aspect_ratio: '9:16',
      quality: 'medium',
    },
  });
  return toUrl(out);
}

// Seedance: reference image maps to the [Image1] bracket token appended to the prompt.
// Retries the known-transient ReadError (mirrors production withReplicateRetry).
async function seedance(prompt: string, imgUrl: string): Promise<string> {
  const input = {
    prompt: `${prompt} [Image1]`,
    duration: DURATION,
    resolution: '720p',
    aspect_ratio: ASPECT,
    generate_audio: true,
    reference_images: [imgUrl],
  };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return toUrl(await replicate.run(SEEDANCE, { input }));
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      if (!/ReadError|ECONNRESET|timeout|throttled|Too Many Requests|429|502|503|504/i.test(msg)) throw e;
      const wait = /429|throttled/i.test(msg) ? 12000 : 3000 * attempt;
      console.log(`  Seedance transient (attempt ${attempt}/4): ${msg.slice(0, 90)} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// Kling O3: reference image becomes character @Element1; native lip-synced audio when enabled.
async function kling(prompt: string, imgUrl: string): Promise<string> {
  const res = (await fal.subscribe(KLING, {
    input: {
      elements: [{ frontal_image_url: imgUrl, reference_image_urls: [imgUrl] }],
      duration: String(DURATION),
      aspect_ratio: ASPECT,
      generate_audio: true,
      prompt: `@Element1 ${prompt}`,
    },
  })) as { data?: { video?: { url?: string } } };
  const v = res.data?.video?.url;
  if (!v) throw new Error(`kling: no video url in ${JSON.stringify(res.data).slice(0, 300)}`);
  return v;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const out = await fn();
  console.log(`  ${label} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return out;
}

async function main() {
  console.log('1. Generating generic gorilla character (gpt-image-2)…');
  const gorillaUrl = await timed('character', genGorilla);
  const gorillaPath = await download(gorillaUrl, 'vlogger_gorilla.png');
  console.log(`   character → ${gorillaPath}`);

  console.log(`2. Using natural-pace prompt (expansion bypassed):\n   "${SPOKEN}"`);

  const skipKling = process.env.SKIP_KLING === '1';
  console.log(`3. Dispatching${skipKling ? ' Seedance only (SKIP_KLING=1)' : ' both arms — same character'}…`);
  const [seed, kl] = await Promise.allSettled([
    timed('Seedance-mini', () => seedance(PROMPT, gorillaUrl)),
    skipKling ? Promise.reject(new Error('skipped')) : timed('Kling O3', () => kling(PROMPT, gorillaUrl)),
  ]);

  console.log('\n=== RESULTS ===');
  if (seed.status === 'fulfilled') {
    const p = await download(seed.value, 'vlogger_A_seedance.mp4');
    console.log(`A) Seedance-mini : ${p}\n   url: ${seed.value}`);
  } else {
    console.log(`A) Seedance-mini : FAILED — ${seed.reason?.message ?? seed.reason}`);
  }
  if (kl.status === 'fulfilled') {
    const p = await download(kl.value, 'vlogger_B_kling.mp4');
    console.log(`B) Kling O3      : ${p}\n   url: ${kl.value}`);
  } else {
    console.log(`B) Kling O3      : FAILED — ${kl.reason?.message ?? kl.reason}`);
  }
}

main().catch((e) => {
  console.error('spike failed:', e);
  process.exit(1);
});
