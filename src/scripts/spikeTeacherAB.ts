// SPIKE (throwaway) — Language Lessons Teacher A/B, the decisive test:
//   Arm A: gpt-image-2 still (side-by-side frontal board) → Kling v3 i2v (start_image_url = the
//          literal first frame; board text should survive pixel-faithful).
//   Arm B: 7/23 teacher still as ELEMENT → Kling O3 reference-to-video (stills-free pipeline;
//          scene re-rendered from identity). Same face + same line as the 7/23 clip the user
//          already approved by ear — doubles as an O3 run-to-run consistency check.
// Both: same pinned bilingual line, verbatim-lock prompt, 6s, 9:16, audio on.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeTeacherAB.ts
// env: FAL_KEY

import 'dotenv/config';
import { fal } from '@fal-ai/client';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = `${process.env.HOME}/Downloads/spike-teacher-ab`;
const STILL_ARM_A = `${OUT}/still-A-side-by-side.png`;
const STILL_ARM_B = '/private/tmp/claude-501/-Users-andrewhuang/32cfd4f3-c7a4-443e-8742-9963bfb76b2a/scratchpad/teacher_still.png';

fal.config({ credentials: process.env.FAL_KEY });

const KLING_V3 = 'fal-ai/kling-video/v3/standard/image-to-video';
const KLING_O3 = 'fal-ai/kling-video/o3/standard/reference-to-video';
const DURATION = '6';

const SPOKEN = 'Hola. Today\'s word is manzana. Manzana means apple. Repeat after me: manzana.';
// Verbatim lock (7/23): no ad-libbed greeting/lead-in/outro — audio must match the line exactly.
const PROMPT = 'A friendly Spanish teacher speaks directly to the camera in a calm, clear teaching voice. '
  + `She says these exact words and NOTHING else — no greeting beyond the script, no added sentences, `
  + `no improvised lines, no words after the last one: "${SPOKEN}". The spoken audio must match this line verbatim.`;

async function upload(path: string, name: string): Promise<string> {
  const buf = readFileSync(path);
  return fal.storage.upload(new File([buf], name, { type: 'image/png' }));
}

async function download(url: string, name: string): Promise<void> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${name} → ${r.status}`);
  writeFileSync(`${OUT}/${name}`, Buffer.from(await r.arrayBuffer()));
}

function videoUrl(res: unknown, label: string): string {
  const v = (res as { data?: { video?: { url?: string } } })?.data?.video?.url;
  if (!v) throw new Error(`${label}: no video url in ${JSON.stringify(res).slice(0, 300)}`);
  return v;
}

async function armA_v3(startImageUrl: string): Promise<string> {
  const res = await fal.subscribe(KLING_V3, {
    // aspect_ratio is live on the API but missing from the fal client's
    // KlingVideoV3ProImageToVideoInput type (types lag the API) — cast for this throwaway spike.
    input: {
      start_image_url: startImageUrl,
      prompt: PROMPT,
      duration: DURATION,
      aspect_ratio: '9:16',
      generate_audio: true,
    } as Record<string, unknown> as never,
  });
  return videoUrl(res, 'v3');
}

async function armB_o3(teacherUrl: string): Promise<string> {
  const res = await fal.subscribe(KLING_O3, {
    input: {
      elements: [{ frontal_image_url: teacherUrl, reference_image_urls: [teacherUrl] }],
      prompt: `@Element1 ${PROMPT}`,
      duration: DURATION,
      aspect_ratio: '9:16' as const,
      generate_audio: true,
    },
  });
  return videoUrl(res, 'o3');
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  console.log('Uploading stills to fal storage…');
  const [urlA, urlB] = await Promise.all([
    upload(STILL_ARM_A, 'teacher_armA.png'),
    upload(STILL_ARM_B, 'teacher_armB.png'),
  ]);
  console.log('Running both arms in parallel (6s each, audio on)…');
  const t0 = Date.now();
  const [a, b] = await Promise.allSettled([armA_v3(urlA), armB_o3(urlB)]);

  if (a.status === 'fulfilled') {
    await download(a.value, 'armA_v3_i2v.mp4');
    console.log(`✓ Arm A (v3 i2v)  → ${OUT}/armA_v3_i2v.mp4`);
  } else console.log(`✗ Arm A (v3) FAILED: ${String(a.reason).slice(0, 300)}`);

  if (b.status === 'fulfilled') {
    await download(b.value, 'armB_o3_ref.mp4');
    console.log(`✓ Arm B (O3 ref)  → ${OUT}/armB_o3_ref.mp4`);
  } else console.log(`✗ Arm B (O3) FAILED: ${String(b.reason).slice(0, 300)}`);

  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(0)}s. Line on both: "${SPOKEN}"`);
}

main().catch((e) => { console.error('spike failed:', e); process.exit(1); });
