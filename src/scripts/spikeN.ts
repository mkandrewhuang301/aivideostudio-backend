// n=4 coherence + text test for PATH A (gpt-image-2 still → Omni animate).
// One shared anchor, same cat mascot across 4 scenes → tests STYLE + CHARACTER consistency scene-to-scene.
// 3 scenes contain on-screen TEXT → tests whether gpt renders it AND whether Omni keeps it legible while animating.
// Saves each scene's still + animated clip + a frame from the clip.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeN.ts
// env: GEMINI_API_KEY, REPLICATE_API_TOKEN

import 'dotenv/config';
import Replicate from 'replicate';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const KEY = process.env.GEMINI_API_KEY!;
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const STYLE = 'flat vector illustration, bold clean outlines, muted pastel palette, minimal flat shading';
const CHAR = 'the same friendly grey-and-white cartoon cat mascot wearing a green bandana';
const DURATION = 3;

const SCENES = [
  { tag: 'n1', text: true,  still: `${STYLE}, ${CHAR} waving hello, standing next to a chalkboard that clearly reads "HOW PLANTS EAT" in white chalk letters, cozy classroom`, motion: 'the cat waves its paw, gentle friendly bounce; keep the chalkboard text unchanged' },
  { tag: 'n2', text: false, still: `${STYLE}, ${CHAR} pointing up at a big smiling yellow sun in a soft blue sky, green hills`, motion: 'the cat points upward, the sun gently pulses with warm rays' },
  { tag: 'n3', text: true,  still: `${STYLE}, ${CHAR} standing beside a large green leaf, holding a small sign that reads "SUNLIGHT + WATER"`, motion: 'the leaf sways gently, the cat holds the sign steady; keep the sign text unchanged' },
  { tag: 'n4', text: true,  still: `${STYLE}, ${CHAR} giving a big thumbs up, a small rounded badge in the corner reads "TIP"`, motion: 'the cat gives an enthusiastic thumbs up, a small sparkle; keep the badge text unchanged' },
];

function toUrl(o: any): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v && typeof v.url === 'function') return String(v.url());
  if (v && v.url) return String(v.url);
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
async function gptStill(prompt: string, anchorUrl: string, tag: string): Promise<string> {
  const t0 = Date.now();
  const out = await replicate.run('openai/gpt-image-2', { input: { prompt, input_images: [anchorUrl], aspect_ratio: '16:9', quality: 'low' } });
  const url = toUrl(out);
  const { data } = await fetchBase64(url);
  writeFileSync(`${OUT}/${tag}-still.png`, Buffer.from(data, 'base64'));
  console.log(`  still ${tag}: ${((Date.now() - t0) / 1000).toFixed(0)}s → ${tag}-still.png`);
  return url;
}
async function omniAnimate(stillUrl: string, motion: string, tag: string) {
  const t0 = Date.now();
  const img = await fetchBase64(stillUrl);
  const body = {
    model: 'gemini-omni-flash-preview',
    input: [{ type: 'image', data: img.data, mime_type: img.mime }, { type: 'text', text: `Animate this image (<FIRST_FRAME>): ${motion}. Make it a ${DURATION}-second clip.` }],
    response_format: { type: 'video', aspect_ratio: '16:9' },
  };
  const res = await fetch(`${INTERACTIONS}?key=${KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json: any = await res.json();
  if (res.status !== 200) { console.log(`  animate ${tag} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`); throw new Error('omni failed'); }
  const vid = findVideo(json);
  if (!vid?.data) throw new Error(`${tag}: no inline video`);
  const file = `${OUT}/${tag}-clip.mp4`;
  writeFileSync(file, Buffer.from(vid.data, 'base64'));
  try { execFileSync('ffmpeg', ['-y', '-ss', '2', '-i', file, '-frames:v', '1', `${OUT}/${tag}-frame.png`]); } catch {}
  console.log(`  animate ${tag}: ${((Date.now() - t0) / 1000).toFixed(0)}s → ${tag}-clip.mp4 / ${tag}-frame.png`);
}

async function main() {
  if (!KEY || !process.env.REPLICATE_API_TOKEN) { console.error('need both keys'); process.exit(1); }
  console.log('anchor (shared cat mascot)…');
  const anchorUrl = toUrl(await replicate.run('openai/gpt-image-2', { input: { prompt: `${STYLE}, ${CHAR}, standing, centered, plain cream background`, aspect_ratio: '16:9', quality: 'low' } }));
  const { data } = await fetchBase64(anchorUrl);
  writeFileSync(`${OUT}/n-anchor.png`, Buffer.from(data, 'base64'));
  console.log('  → n-anchor.png\n');

  for (const s of SCENES) {
    console.log(`SCENE ${s.tag}${s.text ? ' (has text)' : ''}:`);
    const stillUrl = await gptStill(s.still, anchorUrl, s.tag);
    await omniAnimate(stillUrl, s.motion, s.tag);
  }
  console.log('\nDone. Compare n-anchor + n1..n4 (-still and -frame) for style/character/text coherence.');
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
