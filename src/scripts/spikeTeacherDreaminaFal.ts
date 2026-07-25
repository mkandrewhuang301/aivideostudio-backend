// SPIKE (throwaway) — last door for Seedance-on-teacher: does FAL's hosting of Seedance 2.0
// accept the photoreal Seedream teacher still that Replicate's BytePlus stack E005-blocks twice?
// Same baked still, same pinned bilingual line, 6s, 9:16, audio on.
//
// Run:  cd ~/aivideostudio-backend && npx tsx src/scripts/spikeTeacherDreaminaFal.ts
// env:  FAL_KEY
// cost: ~$0.35

import 'dotenv/config';
import { fal } from '@fal-ai/client';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = `${process.env.HOME}/Downloads/spike-teacher-dreamina`;
const STILL = `${OUT}/still_A_baked.png`;
const SEEDANCE_FAL = 'bytedance/seedance-2.0/fast/image-to-video';

fal.config({ credentials: process.env.FAL_KEY });

const SPOKEN = 'Hola. Today\'s word is manzana. Manzana means apple. Repeat after me: manzana.';
const PROMPT = 'A friendly Spanish teacher speaks directly to the camera in a calm, '
  + 'clear teaching voice. She says these exact words and NOTHING else — no greeting beyond the '
  + `script, no added sentences, no improvised lines, no words after the last one: "${SPOKEN}". `
  + 'The spoken audio must match this line verbatim.';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const buf = readFileSync(STILL);
  const stillUrl = await fal.storage.upload(new File([buf], 'teacher_baked.png', { type: 'image/png' }));
  console.log('still uploaded, dispatching fal Seedance 2.0 fast i2v…');

  try {
    const res = (await fal.subscribe(SEEDANCE_FAL, {
      input: {
        image_url: stillUrl,
        prompt: PROMPT,
        duration: 6,
        resolution: '720p',
        aspect_ratio: '9:16',
        generate_audio: true,
      } as Record<string, unknown> as never,
    })) as { data?: { video?: { url?: string } } };
    const v = res.data?.video?.url;
    if (!v) throw new Error(`no video url in ${JSON.stringify(res.data).slice(0, 400)}`);
    const r = await fetch(v);
    writeFileSync(`${OUT}/teacher_C_fal_seedance.mp4`, Buffer.from(await r.arrayBuffer()));
    console.log(`PASS — fal accepted the photoreal teacher: ${OUT}/teacher_C_fal_seedance.mp4\nurl: ${v}`);
  } catch (e) {
    console.log(`BLOCKED/FAILED — ${String((e as Error)?.message ?? e).slice(0, 400)}`);
    process.exit(1);
  }
}

main();
