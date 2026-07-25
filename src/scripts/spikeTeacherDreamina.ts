// SPIKE (throwaway) — Teacher pipeline re-route test: Seedream-4 ("Dreamina") stills +
// Seedance 2.0 Mini animation, replacing gpt-image-2 + Kling v3.
//   Arm A: Seedream still (phrase BAKED on board) → Mini first-frame i2v (literal first frame,
//          the property that won v3 the job). Judges: E005 realistic-face block (fired 7/23 on a
//          gpt still — does a ByteDance-native still pass?), board text survival, lip-sync.
//   Arm B: Seedream still (BLANK board) → Seedream edit (phrase written) → Mini first+last-frame
//          i2v = the "write-on-board" beat without Kling v3's end_image_url.
// Same pinned bilingual line as the 7/24 verified v3 winner. 6s, 9:16, 720p, audio on.
//
// Run:  cd ~/aivideostudio-backend && npx tsx src/scripts/spikeTeacherDreamina.ts
// env:  REPLICATE_API_TOKEN (from .env)
// cost: ~3×$0.03 Seedream + 2×~$0.26 Mini ≈ $0.62

import 'dotenv/config';
import Replicate from 'replicate';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = `${process.env.HOME}/Downloads/spike-teacher-dreamina`;
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const SEEDREAM = 'bytedance/seedream-4';
const SEEDANCE = 'bytedance/seedance-2.0-mini';
const DURATION = 6;

const PHRASE = 'la manzana — apple';
const SPOKEN = 'Hola. Today\'s word is manzana. Manzana means apple. Repeat after me: manzana.';

const COMPOSITION = 'Photorealistic friendly female Spanish teacher in her 30s standing in the '
  + 'left third of the frame, warm smile, facing camera. To her right, occupying the right '
  + 'two-thirds of the frame: a white whiteboard flat on the wall, parallel to the image plane, '
  + 'shot straight-on (NOT angled). Bright modern classroom, soft daylight, vertical 9:16.';

const STILL_BAKED = `${COMPOSITION} On the upper area of the board, in neat teacher handwriting, `
  + `black dry-erase marker, is written exactly this text: "${PHRASE}". No other text anywhere.`;
const STILL_BLANK = `${COMPOSITION} The whiteboard is completely blank — no text, no marks, `
  + 'no logos anywhere in the image.';
const EDIT_WRITE = `Write exactly this text on the whiteboard: "${PHRASE}", in neat teacher `
  + 'handwriting, black dry-erase marker, upper area of the board. This is a photograph — keep '
  + 'the person, her face, pose, clothing, the background and the lighting pixel-identical. '
  + 'The ONLY change is the added text on the board.';

const ANIMATE_PROMPT = 'A friendly Spanish teacher speaks directly to the camera in a calm, '
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

async function download(url: string, name: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${name} → ${r.status}`);
  const path = `${OUT}/${name}`;
  writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  return path;
}

async function seedreamRaw(prompt: string, imageInput?: string): Promise<string> {
  const input: Record<string, unknown> = { prompt, aspect_ratio: '9:16', size: '2K' };
  if (imageInput) input.image_input = [imageInput];
  return toUrl(await replicate.run(SEEDREAM, { input: input as never }));
}

async function withRetry(label: string, fn: () => Promise<string>): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      if (/sensitive|E005/i.test(msg)) throw new Error(`MODERATION BLOCK: ${msg.slice(0, 160)}`);
      if (!/ReadError|ECONNRESET|timeout|throttled|Too Many Requests|429|502|503|504/i.test(msg)) throw e;
      const wait = /429|throttled/i.test(msg) ? 12000 : 3000 * attempt;
      console.log(`  ${label} transient (attempt ${attempt}/5): ${msg.slice(0, 90)} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

const seedream = (prompt: string, imageInput?: string) => withRetry('Seedream', () => seedreamRaw(prompt, imageInput));

async function seedance(label: string, input: Record<string, unknown>): Promise<string> {
  return withRetry(label, async () => toUrl(await replicate.run(SEEDANCE, { input: input as never })));
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  // Reuse stills from a previous run if present (429-throttled reruns shouldn't re-spend).
  const stillAPath = `${OUT}/still_A_baked.png`;
  const stillBPath = `${OUT}/still_B_blank.png`;
  const writtenPath = `${OUT}/still_B_written.png`;
  const have = (p: string) => { try { readFileSync(p); return true; } catch { return false; } };

  let bakedUrl: string, blankUrl: string, writtenUrl: string;
  if (have(stillAPath) && have(stillBPath) && have(writtenPath)) {
    console.log('1-2. Reusing stills from previous run.');
    // Seedance/Seedream accept Buffers — replicate client uploads them.
    bakedUrl = readFileSync(stillAPath) as unknown as string;
    blankUrl = readFileSync(stillBPath) as unknown as string;
    writtenUrl = readFileSync(writtenPath) as unknown as string;
  } else {
    console.log('1. Seedream stills (baked-text arm A, blank arm B)…');
    [bakedUrl, blankUrl] = await Promise.all([seedream(STILL_BAKED), seedream(STILL_BLANK)]);
    await download(bakedUrl, 'still_A_baked.png');
    await download(blankUrl, 'still_B_blank.png');
    console.log('   stills saved');

    console.log('2. Seedream edit: write phrase on blank board (arm B end frame)…');
    writtenUrl = await seedream(EDIT_WRITE, blankUrl);
    await download(writtenUrl, 'still_B_written.png');
    console.log('   edit saved');
  }

  console.log('3. Animating both arms on Seedance Mini…');
  const [a, b] = await Promise.allSettled([
    seedance('Arm A', {
      image: bakedUrl, prompt: ANIMATE_PROMPT, duration: DURATION,
      resolution: '720p', aspect_ratio: '9:16', generate_audio: true,
    }),
    seedance('Arm B', {
      image: blankUrl, last_frame_image: writtenUrl, prompt: ANIMATE_PROMPT,
      duration: DURATION, resolution: '720p', aspect_ratio: '9:16', generate_audio: true,
    }),
  ]);

  console.log('\n=== RESULTS ===');
  if (a.status === 'fulfilled') {
    const p = await download(a.value, 'teacher_A_baked_seedance.mp4');
    console.log(`A) baked→Mini   : ${p}\n   url: ${a.value}`);
  } else console.log(`A) baked→Mini   : FAILED — ${a.reason?.message ?? a.reason}`);
  if (b.status === 'fulfilled') {
    const p = await download(b.value, 'teacher_B_writebeat_seedance.mp4');
    console.log(`B) write-beat   : ${p}\n   url: ${b.value}`);
  } else console.log(`B) write-beat   : FAILED — ${b.reason?.message ?? b.reason}`);
}

main().catch((e) => {
  console.error('spike failed:', e);
  process.exit(1);
});
