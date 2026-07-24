// Style + method matrix. 4 styles × 2 methods, one scene that stresses TEXT ADHERENCE + a reserved
// TEXT ZONE (clean lower-third for captions). Every case uses a style REFERENCE anchor.
//
//   Method A (gpt→omni): gpt-image-2 still (anchor as input_images ref) → Omni animates it.
//   Method B (omni one-shot): Omni reference-to-video, anchor as <IMAGE_REF_0>, composes+animates.
//
// Per style saves: -anchor.png, -A-still.png, -A-clip.mp4, -A-frame.png, -B-clip.mp4, -B-frame.png.
// Sequential per style, so partial results survive a crash.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeStyles.ts
// env: GEMINI_API_KEY, REPLICATE_API_TOKEN

import 'dotenv/config';
import Replicate from 'replicate';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const KEY = process.env.GEMINI_API_KEY!;
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const TITLE = 'HOW CATS PURR';
// Scene stresses text (the title) + a reserved caption zone (clean lower third).
const SCENE = `a cute cat sitting in the upper-right area, with the title "${TITLE}" shown clearly across the top; leave the entire lower third of the frame as clean empty negative space for captions`;
const MOTION = 'gentle ambient motion, the cat blinks and its tail flicks; keep the title text and the empty lower third unchanged';
const DURATION = 3;

const STYLES = [
  { tag: 'claymation',  desc: 'claymation stop-motion style, sculpted soft modeling clay, fingerprint texture, warm studio lighting, handmade 3D' },
  { tag: 'pixel',       desc: '16-bit pixel art, retro SNES sprite, crisp square pixels, limited palette' },
  { tag: 'flatvector',  desc: 'flat vector illustration, bold clean outlines, muted pastel palette, minimal flat shading' },
  { tag: '3dcartoon',   desc: '3D Pixar-style cartoon render, soft global illumination, rounded glossy forms, cinematic' },
];

function toUrl(o: any): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v?.url && typeof v.url === 'function') return String(v.url());
  if (v?.url) return String(v.url);
  throw new Error('replicate: no output url');
}
async function fetchBase64(u: string) {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`fetch ${u} → ${r.status}`);
  return { data: Buffer.from(await r.arrayBuffer()).toString('base64'), mime: r.headers.get('content-type') ?? 'image/png' };
}
function findVideo(node: any): { data?: string } | null {
  if (node && typeof node === 'object') {
    if ((node.type === 'video' || node.mime_type?.startsWith?.('video')) && node.data) return { data: node.data };
    for (const k of Object.keys(node)) { const f = findVideo(node[k]); if (f) return f; }
  }
  return null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gptImage(prompt: string, inputImages: string[] | undefined, tag: string): Promise<string> {
  const t0 = Date.now();
  const input: any = { prompt, aspect_ratio: '16:9', quality: 'low' };
  if (inputImages) input.input_images = inputImages;
  const url = toUrl(await replicate.run('openai/gpt-image-2', { input }));
  const { data } = await fetchBase64(url);
  writeFileSync(`${OUT}/${tag}.png`, Buffer.from(data, 'base64'));
  console.log(`    gpt ${tag}: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return url;
}

// mode 'ref' = reference-to-video (image guides style, Omni composes); mode 'first' = animate the still as first frame.
async function omni(refImgUrl: string, promptText: string, tag: string, mode: 'ref' | 'first') {
  const img = await fetchBase64(refImgUrl);
  const body = {
    model: 'gemini-omni-flash-preview',
    input: [{ type: 'image', data: img.data, mime_type: img.mime }, { type: 'text', text: promptText }],
    response_format: { type: 'video', aspect_ratio: '16:9' },
  };
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${INTERACTIONS}?key=${KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json: any = await res.json();
    if (res.status === 200) {
      const vid = findVideo(json);
      if (!vid?.data) throw new Error(`${tag}: no inline video`);
      const file = `${OUT}/${tag}-clip.mp4`;
      writeFileSync(file, Buffer.from(vid.data, 'base64'));
      try { execFileSync('ffmpeg', ['-y', '-ss', '1.5', '-i', file, '-frames:v', '1', `${OUT}/${tag}-frame.png`]); } catch {}
      console.log(`    omni ${tag} (${mode}): ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      return;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { console.log(`    omni ${tag} HTTP ${res.status} — retry ${attempt}`); await sleep(5000 * attempt); continue; }
    console.log(`    omni ${tag} FAILED HTTP ${res.status}: ${JSON.stringify(json).slice(0, 160)}`);
    return; // don't abort the whole matrix on one failure
  }
}

async function main() {
  if (!KEY || !process.env.REPLICATE_API_TOKEN) { console.error('need both keys'); process.exit(1); }
  for (const s of STYLES) {
    console.log(`\n=== ${s.tag} ===`);
    // Style reference anchor (neutral subject) — used by BOTH methods.
    const anchorUrl = await gptImage(`${s.desc}, a friendly cat mascot, centered, plain background`, undefined, `${s.tag}-anchor`);

    // Method A: gpt still (anchored) → Omni animate as first frame.
    const stillUrl = await gptImage(`${s.desc}. ${SCENE}.`, [anchorUrl], `${s.tag}-A-still`);
    await omni(stillUrl, `Animate this image (<FIRST_FRAME>): ${MOTION}. Keep the exact art style. Make it a ${DURATION}-second clip.`, `${s.tag}-A`, 'first');

    // Method B: Omni one-shot with the anchor as a style reference.
    await omni(anchorUrl, `In the exact ${s.desc} style of <IMAGE_REF_0>: ${SCENE}. ${MOTION}. Make it a ${DURATION}-second clip.`, `${s.tag}-B`, 'ref');
  }
  console.log('\nDone. Per style compare: -A-frame (gpt→omni) vs -B-frame (omni one-shot); check title text + clean lower third.');
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
