// SPIKE (throwaway) — does Replicate Seedance 2.0 MINI accept the fal-Seedream-v5 photoreal
// teacher still that fal-Seedance just passed? If yes, teacher hits Mini pricing (~$0.044/s)
// instead of fal fast pricing. Same still (still_C_fal_seedream.png), same pinned line, 6s.
//
// Run:  cd ~/aivideostudio-backend && npx tsx src/scripts/spikeTeacherMiniFalStill.ts
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
const PROMPT = 'A friendly Spanish teacher speaks directly to the camera in a calm, '
  + 'clear teaching voice. She says these exact words and NOTHING else — no greeting beyond the '
  + `script, no added sentences, no improvised lines, no words after the last one: "${SPOKEN}". `
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
  console.log('Dispatching Replicate Mini on fal-Seedream-v5 still…');
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const url = toUrl(await replicate.run(SEEDANCE, {
        input: {
          image: frame, prompt: PROMPT, duration: 6,
          resolution: '720p', aspect_ratio: '9:16', generate_audio: true,
        } as never,
      }));
      const r = await fetch(url);
      writeFileSync(`${OUT}/teacher_D_mini_falstill.mp4`, Buffer.from(await r.arrayBuffer()));
      console.log(`PASS — Replicate Mini accepted: ${OUT}/teacher_D_mini_falstill.mp4\nurl: ${url}`);
      return;
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      if (/sensitive|E005/i.test(msg)) {
        console.log(`BLOCKED — E005 again on Replicate: ${msg.slice(0, 200)}`);
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
