// Voice-quality A/B on the SAME gorilla + SAME expanded prompt: Seedance-2.0-mini vs Kling O3.
// The open question: Seedance's speech stutters and sounds synthetic; Kling sounded human on a
// real face but poor on the gorilla. Does the new natural-human VOICE_DIRECTION fix Kling's
// cartoon-character voice? If yes, the vlogger's audio problem is solvable by paying for Kling.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeVlogVoiceAB.ts
// env: OPENAI_API_KEY, REPLICATE_API_TOKEN, FAL_KEY

import 'dotenv/config';
import Replicate from 'replicate';
import { fal } from '@fal-ai/client';
import { writeFileSync } from 'node:fs';
import { expandScript } from '../services/openaiScriptService';
import { SERVER_PRESETS } from '../config/presets';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/32cfd4f3-c7a4-443e-8742-9963bfb76b2a/scratchpad';
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
fal.config({ credentials: process.env.FAL_KEY });

const KLING_O3 = 'fal-ai/kling-video/o3/standard/reference-to-video';
const USER_SCRIPT = "I finally got a whole crate of bananas, taste testing all of them today.";

function toUrl(o: unknown): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v && typeof (v as { url?: unknown }).url === 'function') return String((v as { url: () => unknown }).url());
  if (v && (v as { url?: unknown }).url) return String((v as { url: unknown }).url);
  throw new Error('replicate: no output url');
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      if (!/ReadError|ECONNRESET|timeout|throttled|Too Many Requests|429|502|503|504/i.test(msg)) throw e;
      const wait = /429|throttled/i.test(msg) ? 15000 : 4000 * attempt;
      console.log(`  ${label} transient (${attempt}/5) — retry in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function save(url: string, name: string): Promise<string> {
  const r = await fetch(url);
  const path = `${OUT}/${name}`;
  writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  return path;
}

async function main() {
  const preset = SERVER_PRESETS.find((p) => p.preset_id === 'gorilla-vlogs')!;
  const maxSeconds = preset.cost?.type === 'per_second' ? preset.cost.max_seconds : 5;
  const template = preset.dialogue_prompt_template || preset.prompt_template || '{script}';

  const prompt = await expandScript({
    userScript: USER_SCRIPT,
    dialogueTemplate: template,
    durationSeconds: maxSeconds,
  });
  console.log(`--- SHARED PROMPT ---\n${prompt}\n`);

  console.log('Generating the gorilla character…');
  const charUrl = toUrl(await withRetry('gpt-image-2', () => replicate.run('openai/gpt-image-2', {
    input: {
      prompt: 'A friendly cartoon gorilla vlogger in a colorful hoodie, selfie-style portrait, '
        + 'relaxed natural smile, cozy bedroom background, vertical 9:16 framing',
      aspect_ratio: '9:16',
      quality: 'medium',
    },
  })));

  console.log('Dispatching both arms…');
  const [seed, kl] = await Promise.allSettled([
    withRetry('Seedance', () => replicate.run('bytedance/seedance-2.0-mini', {
      input: {
        prompt: `${prompt} [Image1]`,
        duration: maxSeconds,
        resolution: '720p',
        aspect_ratio: '9:16',
        generate_audio: true,
        reference_images: [charUrl],
      },
    })).then(toUrl),
    (async () => {
      const res = (await fal.subscribe(KLING_O3, {
        input: {
          elements: [{ frontal_image_url: charUrl, reference_image_urls: [charUrl] }],
          duration: String(maxSeconds),
          aspect_ratio: '9:16',
          generate_audio: true,
          prompt: `@Element1 ${prompt}`,
        },
      })) as { data?: { video?: { url?: string } } };
      const u = res.data?.video?.url;
      if (!u) throw new Error('kling: no video url');
      return u;
    })(),
  ]);

  console.log('\n=== RESULTS ===');
  if (seed.status === 'fulfilled') console.log(`A Seedance: ${await save(seed.value, 'voice_A_seedance.mp4')}`);
  else console.log(`A Seedance: FAILED — ${seed.reason?.message ?? seed.reason}`);
  if (kl.status === 'fulfilled') console.log(`B Kling O3: ${await save(kl.value, 'voice_B_kling.mp4')}`);
  else console.log(`B Kling O3: FAILED — ${kl.reason?.message ?? kl.reason}`);
  console.log('\nJudge: which voice sounds like a real person, and does either stutter?');
}

main().catch((e) => { console.error('spike failed:', e); process.exit(1); });
