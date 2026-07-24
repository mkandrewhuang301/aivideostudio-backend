// Can a realistic (synthetic) language-lesson teacher be ANIMATED with exact-script audio?
// 1. gpt-image-2 generates a realistic human teacher still.
// 2. Kling O3 animates it (element + audio-explicit prompt that locks the exact spoken words).
// ONLY_SEEDANCE=1 instead checks whether Seedance blocks a realistic face.
//
// Run:  cd ~/aivideostudio-backend && npx tsx src/scripts/spikeTeacherAnimate.ts
// env:  OPENAI_API_KEY, REPLICATE_API_TOKEN, FAL_KEY

import 'dotenv/config';
import Replicate from 'replicate';
import { fal } from '@fal-ai/client';
import { writeFileSync } from 'node:fs';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/32cfd4f3-c7a4-443e-8742-9963bfb76b2a/scratchpad';
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
fal.config({ credentials: process.env.FAL_KEY });

const KLING = 'fal-ai/kling-video/o3/standard/reference-to-video';
const DURATION = 6;

const SPOKEN = "Hola. Today's word is manzana. Manzana means apple. Repeat after me: manzana.";
// Audio-explicit prompt: lock the exact words, forbid any ad-libbed intro/outro so the lip-sync
// track matches the script (the earlier run improvised a "let's learn some new words" lead-in).
const PROMPT = `A friendly Spanish teacher speaks directly to the camera in a calm, clear teaching voice. `
  + `She says these exact words and NOTHING else — no greeting beyond the script, no added sentences, `
  + `no improvised lines, no words after the last one: "${SPOKEN}". The spoken audio must match this line verbatim.`;

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

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      if (!/ReadError|ECONNRESET|timeout|throttled|Too Many Requests|429|502|503|504/i.test(msg)) throw e;
      const wait = /429|throttled/i.test(msg) ? 12000 : 3000 * attempt;
      console.log(`  ${label} transient (${attempt}/4): ${msg.slice(0, 90)} — retry in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function genTeacher(): Promise<string> {
  const out = await withRetry('gpt-image-2', () => replicate.run('openai/gpt-image-2', {
    input: {
      prompt:
        'Photographic portrait of a friendly realistic Latina Spanish teacher in her early 30s, '
        + 'warm genuine smile, standing beside a whiteboard with Spanish vocabulary words, cozy '
        + 'bright classroom, soft natural window light, looking directly at the camera, casual '
        + 'cardigan, vertical 9:16 framing, natural skin texture, realistic photography',
      aspect_ratio: '9:16',
      quality: 'high',
    },
  }));
  return toUrl(out);
}

// Does Seedance even accept a realistic human face? Reference-to-video, audio-on, with retry on
// transient/throttle. A content-policy block surfaces here as a failed prediction.
async function seedanceAnimate(imgUrl: string): Promise<string> {
  const input = {
    prompt: `${PROMPT} [Image1]`,
    duration: DURATION,
    resolution: '720p',
    aspect_ratio: '9:16',
    generate_audio: true,
    reference_images: [imgUrl],
  };
  return toUrl(await withRetry('Seedance', () => replicate.run('bytedance/seedance-2.0-mini', { input })));
}

async function klingAnimate(imgUrl: string): Promise<string> {
  const res = (await fal.subscribe(KLING, {
    input: {
      elements: [{ frontal_image_url: imgUrl, reference_image_urls: [imgUrl] }],
      duration: String(DURATION),
      aspect_ratio: '9:16',
      generate_audio: true,
      prompt: `@Element1 ${PROMPT}`,
    },
  })) as { data?: { video?: { url?: string } } };
  const v = res.data?.video?.url;
  if (!v) throw new Error(`kling: no video url in ${JSON.stringify(res.data).slice(0, 300)}`);
  return v;
}

async function main() {
  console.log('1. Generating realistic teacher (gpt-image-2, high)…');
  const teacherUrl = await genTeacher();
  const teacherPath = await download(teacherUrl, 'teacher_still.png');
  console.log(`   still → ${teacherPath}`);

  if (process.env.ONLY_SEEDANCE === '1') {
    console.log('2. Testing whether Seedance-mini accepts a realistic face…');
    try {
      const t0 = Date.now();
      const vid = await seedanceAnimate(teacherUrl);
      const p = await download(vid, 'teacher_seedance.mp4');
      console.log(`\nSEEDANCE: OK in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${p}\n   url: ${vid}`);
    } catch (e) {
      console.log(`\nSEEDANCE: FAILED (blocked?) — ${(e as Error)?.message ?? e}`);
    }
    return;
  }

  console.log('2. Animating with Kling O3 (audio-explicit prompt)…');
  const t0 = Date.now();
  const vid = await klingAnimate(teacherUrl);
  const p = await download(vid, 'teacher_animated_kling.mp4');
  console.log(`\n=== RESULT ===`);
  console.log(`ANIMATE : OK in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${p}\n   url: ${vid}`);
  console.log(`Listen: audio should be exactly — "${SPOKEN}"`);
}

main().catch((e) => { console.error('spike failed:', e); process.exit(1); });
