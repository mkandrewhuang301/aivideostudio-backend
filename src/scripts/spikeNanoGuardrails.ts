// SPIKE (throwaway) — Nano-banana edit guardrail sweep for the LLM scene-planner (2026-07-24).
// Question: which edit-prompt guardrails does nano need before the planner can trust it with
// board text / prop deltas? Matrix = {content type} × {naive vs guarded prompt} on a fixed base.
//
// Phase 1: gpt-image-2 base stills (blank board + hands-free teacher). Cached — reruns skip.
// Phase 2: nano edits via Gemini-direct (same endpoint as geminiImageService, but a PHOTOREAL
//          preservation suffix — the service's hardcoded one says "This is an illustration").
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeNanoGuardrails.ts
// env: REPLICATE_API_TOKEN, GEMINI_API_KEY

import 'dotenv/config';
import Replicate from 'replicate';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = `${process.env.HOME}/Downloads/spike-nano-edits`;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const NANO_MODEL = process.env.NANO_IMAGE_MODEL ?? 'gemini-3.1-flash-image-preview';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const TEACHER =
  'a friendly realistic Latina Spanish teacher in her early 30s, warm genuine smile, '
  + 'casual beige cardigan over a white top, holding a black whiteboard marker, looking directly '
  + 'at the camera, cozy bright classroom, soft natural window light, natural skin texture, '
  + 'realistic photography';

const BASES: Array<{ file: string; prompt: string }> = [
  {
    file: 'base-board-blank.png',
    prompt:
      `Photographic shot of ${TEACHER}, standing on the left third of the frame beside a large `
      + 'whiteboard that fills the right two-thirds of the frame. The whiteboard is completely '
      + 'BLANK — clean white surface, nothing written or drawn on it. The whiteboard is flat on '
      + 'the wall, directly facing the camera, parallel to the image plane — shot perfectly '
      + 'straight-on, no perspective tilt or angle. Vertical 9:16 framing.',
  },
  {
    file: 'base-teacher-free.png',
    prompt:
      `Photographic shot of ${TEACHER}, standing centered, waist-up, both hands relaxed and `
      + 'empty at her sides, holding nothing. Cozy bright classroom wall behind her, no '
      + 'whiteboard. Vertical 9:16 framing.`,
  },
];

// Preservation suffixes — the guarded arm. Photoreal analogue of the service's illustration suffix.
const GUARD_BOARD = (text: string, extra = '') =>
  `Write exactly this text on the whiteboard: "${text}". Render it in neat teacher handwriting `
  + 'with a black dry-erase marker, large and legible, in the upper area of the whiteboard. '
  + extra
  + 'This is a photograph — keep the teacher, her face, pose, clothing, the classroom, the '
  + 'lighting, and the whiteboard itself pixel-identical. The ONLY change is the added text. '
  + 'Return the complete edited image.';

const GUARD_SCENE = (instruction: string) =>
  `${instruction}. This is a photograph — keep her face, body, clothing, the background, and the `
  + 'lighting pixel-identical. The ONLY change is the one described. Return the complete edited image.';

type Edit = { name: string; base: string; prompt: string };

const EDITS: Edit[] = [
  // ── Board text: content axis × {naive, guarded} ──
  { name: 'board-en-short-naive', base: 'base-board-blank.png', prompt: 'Write "apple" on the whiteboard.' },
  { name: 'board-en-short-guarded', base: 'base-board-blank.png', prompt: GUARD_BOARD('apple') },
  { name: 'board-en-long-naive', base: 'base-board-blank.png', prompt: 'Write "The library is next to the park." on the whiteboard.' },
  { name: 'board-en-long-guarded', base: 'base-board-blank.png', prompt: GUARD_BOARD('The library is next to the park.') },
  { name: 'board-es-accent-naive', base: 'base-board-blank.png', prompt: 'Write "¿Dónde está la biblioteca?" on the whiteboard.' },
  { name: 'board-es-accent-guarded', base: 'base-board-blank.png', prompt: GUARD_BOARD('¿Dónde está la biblioteca?') },
  { name: 'board-zh-naive', base: 'base-board-blank.png', prompt: 'Write "苹果 = apple" on the whiteboard.' },
  { name: 'board-zh-guarded', base: 'base-board-blank.png', prompt: GUARD_BOARD('苹果 = apple') },
  { name: 'board-numbers-naive', base: 'base-board-blank.png', prompt: 'Write "3 + 5 = 8" on the whiteboard.' },
  { name: 'board-numbers-guarded', base: 'base-board-blank.png', prompt: GUARD_BOARD('3 + 5 = 8') },
  {
    name: 'board-multiline-naive', base: 'base-board-blank.png',
    prompt: 'Write a three-line vocabulary list on the whiteboard: "hola — hello", "gracias — thank you", "adiós — goodbye".',
  },
  {
    name: 'board-multiline-guarded', base: 'base-board-blank.png',
    prompt: GUARD_BOARD(
      'hola — hello\ngracias — thank you\nadiós — goodbye',
      'Render it as three separate lines, one vocabulary pair per line, top to bottom. ',
    ),
  },
  // ── Text replacement on the 7/24 still that already has "la manzana - apple" ──
  {
    name: 'board-replace-guarded', base: `${process.env.HOME}/Downloads/spike-teacher-ab/still-A-side-by-side.png`,
    prompt:
      'Replace the text on the whiteboard with exactly this: "el perro — dog". Match the '
      + 'handwriting style, marker color, size, and position of the existing text. This is a '
      + 'photograph — keep the teacher, her face, pose, clothing, the classroom, the lighting, '
      + 'and the whiteboard itself pixel-identical. The ONLY change is the replaced text. '
      + 'Return the complete edited image.',
  },
  // ── Prop / scene edits (non-whiteboard cases) ──
  { name: 'prop-book-naive', base: 'base-teacher-free.png', prompt: 'She is now holding up a red book toward the camera.' },
  {
    name: 'prop-book-guarded', base: 'base-teacher-free.png',
    prompt: GUARD_SCENE('She is now holding up a red hardcover book toward the camera in one raised hand'),
  },
  {
    name: 'prop-flashcard-guarded', base: 'base-teacher-free.png',
    prompt: GUARD_SCENE(
      'She is now holding up a white flashcard toward the camera; the flashcard has a simple '
      + 'drawing of a red apple and the word "apple" written under it in neat handwriting',
    ),
  },
];

function toUrl(o: unknown): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v && typeof (v as { url?: unknown }).url === 'function') return String((v as { url: () => unknown }).url());
  if (v && (v as { url?: unknown }).url) return String((v as { url: unknown }).url);
  throw new Error('gpt-image-2: no output url');
}

async function ensureBases(): Promise<void> {
  for (const b of BASES) {
    const path = `${OUT}/${b.file}`;
    if (existsSync(path)) { console.log(`· ${b.file} cached, skipping`); continue; }
    const t0 = Date.now();
    const out = await replicate.run('openai/gpt-image-2', {
      input: { prompt: b.prompt, aspect_ratio: '9:16', quality: 'high' },
    });
    const res = await fetch(toUrl(out));
    if (!res.ok) throw new Error(`base download ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    console.log(`✓ ${b.file}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

async function nanoEdit(basePath: string, prompt: string): Promise<Buffer> {
  const base = readFileSync(basePath);
  const response = await fetch(`${GEMINI_URL}/${NANO_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/png', data: base.toString('base64') } },
          { text: prompt },
        ],
      }],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`nano ${response.status}: ${body.slice(0, 200)}`);
  }
  const json = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ inline_data?: { data?: string }; inlineData?: { data?: string } }> } }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const part = parts.find((p) => p.inline_data?.data ?? p.inlineData?.data);
  const data = part?.inline_data?.data ?? part?.inlineData?.data;
  if (!data) throw new Error('nano returned no image part');
  return Buffer.from(data, 'base64');
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await ensureBases();

  console.log(`\nRunning ${EDITS.length} nano edits (concurrency 4)…`);
  const queue = [...EDITS];
  const worker = async (): Promise<void> => {
    for (;;) {
      const e = queue.shift();
      if (!e) return;
      const outPath = `${OUT}/${e.name}.png`;
      if (existsSync(outPath)) { console.log(`· ${e.name} cached, skipping`); continue; }
      const t0 = Date.now();
      try {
        const basePath = e.base.includes('/') ? e.base : `${OUT}/${e.base}`;
        const buf = await nanoEdit(basePath, e.prompt);
        writeFileSync(outPath, buf);
        console.log(`✓ ${e.name}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (err) {
        console.log(`✗ ${e.name} FAILED: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(`\nDone — ${OUT}`);
}

main().catch((e) => { console.error('spike failed:', e); process.exit(1); });
