// Verify the anti-creativity prompt end-to-end on the REAL gorilla-vlogs path: run the actual
// expandScript() (server system prompt + 5s word budget + stamped audio direction), then dispatch
// the result to Seedance-2.0-mini exactly as presetResolver would. The question this answers:
// does naming "no background music" in the prompt actually stop Seedance's fused music track?
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeVlogNoMusic.ts
// env: OPENAI_API_KEY, REPLICATE_API_TOKEN

import 'dotenv/config';
import Replicate from 'replicate';
import { writeFileSync } from 'node:fs';
import { expandScript } from '../services/openaiScriptService';
import { SERVER_PRESETS } from '../config/presets';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/32cfd4f3-c7a4-443e-8742-9963bfb76b2a/scratchpad';
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const USER_SCRIPT = "Hey guys, welcome back! I finally got a whole crate of bananas and I'm shaking. "
  + "Full taste test today, no cuts, and I'll rank every single one from worst to best.";

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

async function main() {
  const preset = SERVER_PRESETS.find((p) => p.preset_id === 'gorilla-vlogs');
  if (!preset) throw new Error('gorilla-vlogs preset not found');
  const maxSeconds = preset.cost?.type === 'per_second' ? preset.cost.max_seconds : 5;
  const template = preset.dialogue_prompt_template || preset.prompt_template || '{script}';

  console.log(`1. expandScript() — preset duration ${maxSeconds}s (budget ${Math.round(maxSeconds * 2.5)} words)`);
  const prompt = await expandScript({
    userScript: USER_SCRIPT,
    dialogueTemplate: template,
    durationSeconds: maxSeconds,
  });
  console.log(`\n--- PROMPT SENT TO SEEDANCE ---\n${prompt}\n`);

  // A generated stand-in for the bundled gorilla (the real character asset is still a TODO).
  console.log('2. Generating the gorilla character still…');
  const charUrl = toUrl(await withRetry('gpt-image-2', () => replicate.run('openai/gpt-image-2', {
    input: {
      prompt: 'A friendly cartoon gorilla vlogger in a colorful hoodie, selfie-style portrait, '
        + 'expressive happy face, cozy bedroom background, vertical 9:16 framing',
      aspect_ratio: '9:16',
      quality: 'medium',
    },
  })));

  console.log('3. Dispatching to Seedance-2.0-mini (audio ON, as the preset does)…');
  const t0 = Date.now();
  const videoUrl = toUrl(await withRetry('Seedance', () => replicate.run('bytedance/seedance-2.0-mini', {
    input: {
      prompt: `${prompt} [Image1]`,
      duration: maxSeconds,
      resolution: '720p',
      aspect_ratio: '9:16',
      generate_audio: true,
      reference_images: [charUrl],
    },
  })));
  console.log(`   done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const res = await fetch(videoUrl);
  const path = `${OUT}/vlog_nomusic_test.mp4`;
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  console.log(`\n=== RESULT ===\n${path}\n${videoUrl}`);
  console.log('\nListen for: speech only, natural room tone, NO music bed.');
}

main().catch((e) => { console.error('spike failed:', e); process.exit(1); });
