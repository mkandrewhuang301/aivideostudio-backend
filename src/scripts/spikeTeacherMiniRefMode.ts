// SPIKE (throwaway) — LAST untested Mini variant for the teacher: reference_images mode
// (ref-to-video, like the vlogger path) instead of `image` first-frame mode, which E005-blocked
// 3× on photoreal. Andrew wants teacher on Mini; this is the only Mini door left.
// NOTE: ref mode re-renders the scene from identity (O3-style) — board text survival is the
// known risk even if moderation passes. Judges: E005? text? lip-sync?
//
// Run:  cd ~/aivideostudio-backend && npx tsx src/scripts/spikeTeacherMiniRefMode.ts
// env:  REPLICATE_API_TOKEN
// cost: ~$0.26

import 'dotenv/config';
import Replicate from 'replicate';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = `${process.env.HOME}/Downloads/spike-teacher-dreamina`;
const STILL = `${OUT}/still_C_fal_seedream.png`;
const SEEDANCE = 'bytedance/seedance-2.0-mini';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const SPOKEN = 'Hola. Today\'s word is manzana. Manzana means apple. Repeat after me: manzana.';
const PROMPT = 'A friendly Spanish teacher in a bright classroom, standing beside a white '
  + 'whiteboard with "la manzana — apple" written on it in black marker, speaks directly to the '
  + 'camera in a calm, clear teaching voice. She says these exact words and NOTHING else — no '
  + `greeting beyond the script, no added sentences, no improvised lines: "${SPOKEN}". `
  + 'The spoken audio must match this line verbatim.';

function toUrl(o: unknown): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v && typeof (v as { url?: unknown }).url === 'function') return String((v as { url: () => unknown }).url());
  if (v && (v as { url?: unknown }).url) return String((v as { url: unknown }).url);
  throw new Error('replicate: no output url');
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const frame = readFileSync(STILL);
  console.log('Dispatching Replicate Mini REFERENCE_IMAGES mode on fal-Seedream-v5 still…');
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const url = toUrl(await replicate.run(SEEDANCE, {
        input: {
          prompt: `${PROMPT} [Image1]`,
          reference_images: [frame],
          duration: 6,
          resolution: '720p',
          aspect_ratio: '9:16',
          generate_audio: true,
        } as never,
      }));
      const r = await fetch(url);
      writeFileSync(`${OUT}/teacher_E_mini_refmode.mp4`, Buffer.from(await r.arrayBuffer()));
      console.log(`PASS — Mini ref-mode accepted: ${OUT}/teacher_E_mini_refmode.mp4\nurl: ${url}`);
      return;
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      if (/sensitive|E005/i.test(msg)) {
        console.log(`BLOCKED — E005 in ref-mode too: ${msg.slice(0, 200)}`);
        process.exit(1);
      }
      if (!/ReadError|ECONNRESET|timeout|throttled|Too Many Requests|429|502|503|504/i.test(msg)) throw e;
      const wait = /429|throttled/i.test(msg) ? 12000 : 3000 * attempt;
      console.log(`  transient (attempt ${attempt}/5): ${msg.slice(0, 90)} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

main().catch((e) => {
  console.error('spike failed:', e);
  process.exit(1);
});
