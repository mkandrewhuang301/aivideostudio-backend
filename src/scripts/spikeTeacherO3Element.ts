// SPIKE (throwaway) — Arm B REDONE correctly: O3 element = clean frontal PORTRAIT (person only,
// no scene pollution — the canonical-sheet pattern), prompt asks for a flat frontal whiteboard.
// First Arm B run wrongly fed the whole slanted scene still as the element, so O3 cloned the slant.
// This run decides whether O3 obeys COMPOSITION direction when the element is clean.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeTeacherO3Element.ts
// env: FAL_KEY

import 'dotenv/config';
import { fal } from '@fal-ai/client';
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = `${process.env.HOME}/Downloads/spike-teacher-ab`;
const PORTRAIT = `${OUT}/teacher_portrait_element.png`;

fal.config({ credentials: process.env.FAL_KEY });

const KLING_O3 = 'fal-ai/kling-video/o3/standard/reference-to-video';

const SPOKEN = 'Hola. Today\'s word is manzana. Manzana means apple. Repeat after me: manzana.';
const PROMPT = '@Element1 A friendly Spanish teacher in a cozy bright classroom, standing beside a large '
  + 'whiteboard that is flat on the wall directly facing the camera, shot straight-on so the board reads '
  + 'frontal and level, not angled. She speaks directly to the camera in a calm, clear teaching voice. '
  + `She says these exact words and NOTHING else — no greeting beyond the script, no added sentences, `
  + `no improvised lines, no words after the last one: "${SPOKEN}". The spoken audio must match this line verbatim.`;

async function main(): Promise<void> {
  const url = await fal.storage.upload(
    new File([readFileSync(PORTRAIT)], 'teacher_portrait.png', { type: 'image/png' }),
  );
  console.log('Running O3 with portrait-only element…');
  const t0 = Date.now();
  const res = await fal.subscribe(KLING_O3, {
    input: {
      elements: [{ frontal_image_url: url, reference_image_urls: [url] }],
      prompt: PROMPT,
      duration: '6',
      aspect_ratio: '9:16',
      generate_audio: true,
    },
  });
  const v = (res as { data?: { video?: { url?: string } } })?.data?.video?.url;
  if (!v) throw new Error(`no video url in ${JSON.stringify(res).slice(0, 300)}`);
  const r = await fetch(v);
  writeFileSync(`${OUT}/armB2_o3_portrait_element.mp4`, Buffer.from(await r.arrayBuffer()));
  console.log(`✓ ${OUT}/armB2_o3_portrait_element.mp4 in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e) => { console.error('spike failed:', e); process.exit(1); });
