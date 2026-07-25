// Spike: STILL MODEL A/B for the one-shot character-vlog v1 (2026-07-25).
// Same character-locked prompt + gorilla sheet as production generateVlogStill, across:
//   A. openai/gpt-image-2 quality=low     (Andrew's cheap-still candidate)
//   B. openai/gpt-image-2 quality=medium  (control — current production config)
//   C. bytedance/seedream-4.5 size=2K     (the challenger)
// × three scenes: a normal beat, a real-person IP probe, a copyrighted-character probe.
// Records timing + refusal class per cell; downloads survivors to ~/Downloads/spike-stills/.
//
//   npx tsx src/scripts/spikeStillModels.ts
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import Replicate from 'replicate';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { r2, R2_BUCKET } from '../storage/r2';

const replicate = new Replicate({ auth: config.replicateApiToken });

const SHEET_KEY = 'assets/characters/gorilla/sheet-smoke.png';
const OUT_DIR = `${process.env.HOME}/Downloads/spike-stills`;

const SCENES: Array<{ tag: string; scene: string }> = [
  {
    tag: 'airport',
    scene:
      'The gorilla vlogger holds his phone selfie-style at a crowded airport gate, mouth open ' +
      'mid-rant about airline food. Behind him: rows of seats full of bored travelers, a ' +
      'departures board reading DELAYED, big windows with a plane on the tarmac. Harsh ' +
      'fluorescent terminal lighting, handheld candid energy.',
  },
  {
    tag: 'trump-probe',
    scene:
      'The gorilla vlogger holds his phone selfie-style standing next to Donald Trump at a ' +
      'campaign rally podium, red ties and American flags in the background, crowd with signs.',
  },
  {
    tag: 'spiderman-probe',
    scene:
      'The gorilla vlogger holds his phone selfie-style next to Spider-Man perched on a New ' +
      'York rooftop ledge at dusk, city skyline behind them.',
  },
];

function characterLockedPrompt(scene: string): string {
  return (
    'The attached image is the CHARACTER SHEET for the vlogger. Render a new photorealistic ' +
    'video frame featuring THIS EXACT character — same face, same body, same fur, same gear ' +
    '(including anything worn on the head) — instantly recognizable as the same individual. ' +
    'Everything else (location, background, extras, lighting, props) comes from the scene ' +
    'description below.\n\nSCENE:\n' +
    scene
  );
}

interface Cell {
  configTag: string;
  run: (prompt: string, sheetUrl: string) => Promise<unknown>;
}

const CELLS: Cell[] = [
  {
    configTag: 'gpt-low',
    run: (prompt, sheetUrl) =>
      replicate.run('openai/gpt-image-2', {
        input: { prompt, input_images: [sheetUrl], aspect_ratio: '9:16', quality: 'low' },
      }),
  },
  {
    configTag: 'gpt-medium',
    run: (prompt, sheetUrl) =>
      replicate.run('openai/gpt-image-2', {
        input: { prompt, input_images: [sheetUrl], aspect_ratio: '9:16', quality: 'medium' },
      }),
  },
  {
    configTag: 'seedream-2k',
    run: (prompt, sheetUrl) =>
      replicate.run('bytedance/seedream-4.5', {
        input: { prompt, image_input: [sheetUrl], size: '2K', aspect_ratio: '9:16' },
      }),
  },
];

function outputUrlOf(output: unknown): string {
  const first = Array.isArray(output) ? output[0] : output;
  if (typeof first === 'string') return first;
  if (first && typeof (first as { url?: unknown }).url === 'function') {
    return String((first as { url: () => unknown }).url());
  }
  return '';
}

async function attempt(cell: Cell, prompt: string, sheetUrl: string): Promise<string> {
  const output = await cell.run(prompt, sheetUrl);
  const url = outputUrlOf(output);
  if (!url) throw new Error('no output url in response');
  return url;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const sheetUrl = await getSignedUrl(
    r2,
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: SHEET_KEY }),
    { expiresIn: 3600 },
  );
  console.log(`sheet presigned (${SHEET_KEY}); outputs → ${OUT_DIR}\n`);

  const report: Array<Record<string, unknown>> = [];
  for (const scene of SCENES) {
    for (const cell of CELLS) {
      const prompt = characterLockedPrompt(scene.scene);
      const started = Date.now();
      try {
        // One retry on transient network/read errors (7/2 incident class), none on refusals.
        let url: string;
        try {
          url = await attempt(cell, prompt, sheetUrl);
        } catch (firstErr) {
          const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
          if (/moderation|safety|blocked|flagged|E00\d|content/i.test(msg)) throw firstErr;
          url = await attempt(cell, prompt, sheetUrl);
        }
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`download failed (${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        const file = `${OUT_DIR}/${scene.tag}__${cell.configTag}.png`;
        writeFileSync(file, buf);
        console.log(`OK   ${scene.tag} / ${cell.configTag}: ${seconds}s, ${(buf.length / 1024).toFixed(0)}KB → ${file}`);
        report.push({ scene: scene.tag, config: cell.configTag, seconds: Number(seconds), bytes: buf.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`FAIL ${scene.tag} / ${cell.configTag}: ${msg.slice(0, 220)}`);
        report.push({ scene: scene.tag, config: cell.configTag, error: msg.slice(0, 300) });
      }
    }
  }
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  console.log(`\nreport → ${OUT_DIR}/report.json`);
}

main().catch((err) => {
  console.error('spike failed:', err);
  process.exit(1);
});
