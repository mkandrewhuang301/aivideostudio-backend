// Two more Seedance-2.0-mini samples through the REAL preset path, for Andrew to verify whether
// the speech stutter ("whole whole") is systemic or a one-off. Different lines each, run
// SEQUENTIALLY (Replicate throttles to burst-1 while account credit is low).
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeSeedanceStutter.ts
// env: OPENAI_API_KEY, REPLICATE_API_TOKEN

import 'dotenv/config';
import Replicate from 'replicate';
import { writeFileSync } from 'node:fs';
import { expandScript } from '../services/openaiScriptService';
import { SERVER_PRESETS } from '../config/presets';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/32cfd4f3-c7a4-443e-8742-9963bfb76b2a/scratchpad';
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const SAMPLES = [
  { tag: 'c1', script: 'Trying the new ramen place down the street today.' },
  { tag: 'c2', script: 'Okay so my package finally showed up after three weeks.' },
];

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
  const preset = SERVER_PRESETS.find((p) => p.preset_id === 'gorilla-vlogs')!;
  const maxSeconds = preset.cost?.type === 'per_second' ? preset.cost.max_seconds : 5;
  const template = preset.dialogue_prompt_template || preset.prompt_template || '{script}';

  console.log('Generating one gorilla character (shared by both samples)…');
  const charUrl = toUrl(await withRetry('gpt-image-2', () => replicate.run('openai/gpt-image-2', {
    input: {
      prompt: 'A friendly cartoon gorilla vlogger in a colorful hoodie, selfie-style portrait, '
        + 'relaxed natural smile, cozy bedroom background, vertical 9:16 framing',
      aspect_ratio: '9:16',
      quality: 'medium',
    },
  })));

  for (const s of SAMPLES) {
    console.log(`\n[${s.tag}] "${s.script}"`);
    const prompt = await expandScript({
      userScript: s.script,
      dialogueTemplate: template,
      durationSeconds: maxSeconds,
    });
    const spoken = (prompt.match(/The character says:\s*"([^"]+)"/) ?? [])[1] ?? '(unparsed)';
    console.log(`  spoken line: "${spoken}"`);

    // Seedance also false-positives on copyright for benign prompts — don't let one sample abort
    // the run, and retry once since the block is not always deterministic.
    let saved = false;
    for (let attempt = 1; attempt <= 2 && !saved; attempt += 1) {
      try {
        const url = toUrl(await withRetry('Seedance', () => replicate.run('bytedance/seedance-2.0-mini', {
          input: {
            prompt: `${prompt} [Image1]`,
            duration: maxSeconds,
            resolution: '720p',
            aspect_ratio: '9:16',
            generate_audio: true,
            reference_images: [charUrl],
          },
        })));
        const res = await fetch(url);
        const path = `${OUT}/stutter_${s.tag}_seedance.mp4`;
        writeFileSync(path, Buffer.from(await res.arrayBuffer()));
        console.log(`  → ${path}`);
        saved = true;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        console.log(`  [${s.tag}] attempt ${attempt} FAILED — ${msg.split('Request id')[0].trim()}`);
        if (attempt === 2) console.log(`  [${s.tag}] giving up on this sample`);
      }
    }
  }

  console.log('\nListen for: does a word repeat/double? Does it sound synthetic vs a real person?');
}

main().catch((e) => { console.error('spike failed:', e); process.exit(1); });
