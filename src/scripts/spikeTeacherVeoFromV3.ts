// SPIKE (throwaway) — LAST ONE: Veo 3.1 Lite on the WINNING v3 teacher clip's frame.
// armA_v3_i2v.mp4 = Andrew's quality anchor ("best one I've seen"). Extract its 0.5s frame →
// Veo 3.1 Lite i2v, same pinned bilingual line, 6s, 9:16, 720p. Judges: board text survival,
// identity hold, Spanish audio (Veo lite audio = untested; no generate_audio toggle in schema).
//
// Run:  cd ~/aivideostudio-backend && npx tsx src/scripts/spikeTeacherVeoFromV3.ts
// env:  REPLICATE_API_TOKEN
// cost: ~$0.30 (6s × $0.05)

import 'dotenv/config';
import Replicate from 'replicate';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = `${process.env.HOME}/Downloads/spike-teacher-ab`;
const FRAME = `${OUT}/v3_winner_frame.png`;
const VEO = 'google/veo-3.1-lite';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const SPOKEN = 'Hola. Today\'s word is manzana. Manzana means apple. Repeat after me: manzana.';
const PROMPT = 'A friendly Spanish teacher speaks directly to the camera in a calm, clear '
  + 'teaching voice. She says these exact words and NOTHING else — no greeting beyond the '
  + `script, no added sentences, no improvised lines, no words after the last one: "${SPOKEN}". `
  + 'The spoken audio must match this line verbatim. No subtitles, no on-screen text, no captions.';

function toUrl(o: unknown): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v && typeof (v as { url?: unknown }).url === 'function') return String((v as { url: () => unknown }).url());
  if (v && (v as { url?: unknown }).url) return String((v as { url: unknown }).url);
  throw new Error('replicate: no output url');
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const frame = readFileSync(FRAME);
  console.log('Dispatching Veo 3.1 Lite on v3-winner frame…');
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const url = toUrl(await replicate.run(VEO, {
        input: {
          image: frame, prompt: PROMPT, duration: 6,
          resolution: '720p', aspect_ratio: '9:16',
        } as never,
      }));
      const r = await fetch(url);
      writeFileSync(`${OUT}/teacher_veo31_from_v3frame.mp4`, Buffer.from(await r.arrayBuffer()));
      console.log(`DONE: ${OUT}/teacher_veo31_from_v3frame.mp4\nurl: ${url}`);
      return;
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
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
