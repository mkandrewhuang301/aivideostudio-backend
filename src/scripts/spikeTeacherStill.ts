// SPIKE (throwaway) — Teacher still candidates for the v3-vs-O3 A/B, fixing the 7/23 flaw:
// the whiteboard was slanted/three-quarter. These prompts pin the board FLAT to camera
// (parallel to the image plane, shot straight-on) so baked vocab text reads level.
// Two compositions: A = teacher left / board right; B = teacher centered in front of board.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeTeacherStill.ts
// env: REPLICATE_API_TOKEN

import 'dotenv/config';
import Replicate from 'replicate';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = `${process.env.HOME}/Downloads/spike-teacher-ab`;
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const TEACHER =
  'a friendly realistic Latina Spanish teacher in her early 30s, warm genuine smile, '
  + 'casual beige cardigan over a white top, holding a black whiteboard marker, looking directly '
  + 'at the camera, cozy bright classroom, soft natural window light, natural skin texture, '
  + 'realistic photography';

const BOARD_FLAT =
  'The whiteboard is flat on the wall, directly facing the camera, parallel to the image plane — '
  + 'shot perfectly straight-on, no perspective tilt or angle, so all text on it reads level and '
  + 'legible. Written large on the whiteboard in neat teacher handwriting: "la manzana - apple".';

const VARIANTS: Array<{ name: string; prompt: string }> = [
  {
    name: 'A-side-by-side',
    prompt:
      `Photographic shot of ${TEACHER}, standing on the left third of the frame beside a large `
      + `whiteboard that fills the right two-thirds of the frame. ${BOARD_FLAT} Vertical 9:16 framing.`,
  },
  {
    name: 'B-board-behind',
    prompt:
      `Photographic shot of ${TEACHER}, standing centered in front of a large whiteboard that fills `
      + `the wall behind her, with the lesson text written above and beside her head. ${BOARD_FLAT} `
      + `Vertical 9:16 framing.`,
  },
];

function toUrl(o: unknown): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v && typeof (v as { url?: unknown }).url === 'function') return String((v as { url: () => unknown }).url());
  if (v && (v as { url?: unknown }).url) return String((v as { url: unknown }).url);
  throw new Error('gpt-image-2: no output url');
}

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  for (const v of VARIANTS) {
    const t0 = Date.now();
    try {
      const out = await replicate.run('openai/gpt-image-2', {
        input: { prompt: v.prompt, aspect_ratio: '9:16', quality: 'high' },
      });
      const res = await fetch(toUrl(out));
      if (!res.ok) throw new Error(`download ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(`${OUT}/still-${v.name}.png`, buf);
      console.log(`✓ still-${v.name}.png  ${(buf.length / 1024).toFixed(0)}KB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.log(`✗ ${v.name} FAILED: ${String((e as Error)?.message ?? e)}`);
    }
  }
  console.log(`\nDone — ${OUT}`);
}

void run();
