// A/B test: Gemini one-shot scene (B) vs gpt-image-2 still → Gemini animate (A).
// Same style anchor, same scene, 3s clips (cheapest duration lever), lowest res attempted.
// Saves anchor + scene-still + both clips + a frame from each so they can be eyeballed.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeAB.ts
// env: GEMINI_API_KEY, REPLICATE_API_TOKEN

import 'dotenv/config';
import Replicate from 'replicate';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const KEY = process.env.GEMINI_API_KEY!;
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const STYLE = 'flat vector illustration, bold clean outlines, muted pastel palette, minimal flat shading, no text';
const SCENE = 'a fluffy cat sitting on a windowsill looking outside at falling autumn leaves';
const DURATION = 3;

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
  const mime = r.headers.get('content-type') ?? 'image/png';
  return { data: Buffer.from(await r.arrayBuffer()).toString('base64'), mime };
}

function findVideo(node: any): { data?: string; uri?: string } | null {
  if (node && typeof node === 'object') {
    if (node.type === 'video' || node.mime_type?.startsWith?.('video')) {
      if (node.data || node.uri || node.url) return { data: node.data, uri: node.uri ?? node.url };
    }
    for (const k of Object.keys(node)) { const f = findVideo(node[k]); if (f) return f; }
  }
  return null;
}

// NOTE: response_format.resolution is INCONSISTENT — one call accepted it (listing 360p/720p/1080p/4k),
// the next rejected the same field as "Unknown parameter". Dropped for now; cost controlled via 3s duration.

async function omni(label: string, imgB64: { data: string; mime: string }, text: string, tag: string): Promise<string> {
  const responseFormat: any = { type: 'video', aspect_ratio: '16:9' };
  const body = {
    model: 'gemini-omni-flash-preview',
    input: [{ type: 'image', data: imgB64.data, mime_type: imgB64.mime }, { type: 'text', text }],
    response_format: responseFormat,
  };
  const t0 = Date.now();
  let res = await fetch(`${INTERACTIONS}?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json: any = await res.json();
  const ms = Date.now() - t0;
  if (res.status !== 200) { console.log(`  ${label} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`); throw new Error('omni failed'); }
  const vid = findVideo(json);
  if (!vid?.data) throw new Error(`${label}: no inline video (uri=${vid?.uri})`);
  const buf = Buffer.from(vid.data, 'base64');
  const file = `${OUT}/ab-${tag}.mp4`;
  writeFileSync(file, buf);
  const frame = `${OUT}/ab-${tag}.png`;
  try { execFileSync('ffmpeg', ['-y', '-ss', '1.5', '-i', file, '-frames:v', '1', frame]); } catch {}
  const probe = (() => { try { return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration', '-of', 'csv=p=0', file]).toString().trim(); } catch { return '?'; } })();
  console.log(`  ✅ ${label}: ${(buf.length / 1024 / 1024).toFixed(2)}MB, ${(ms / 1000).toFixed(0)}s, [${probe}] → ab-${tag}.mp4 / ab-${tag}.png`);
  return file;
}

async function gptImage(label: string, prompt: string, inputImages: string[] | undefined, tag: string): Promise<string> {
  const t0 = Date.now();
  const input: any = { prompt, aspect_ratio: '16:9', quality: 'low' };
  if (inputImages) input.input_images = inputImages;
  const out = await replicate.run('openai/gpt-image-2', { input });
  const url = toUrl(out);
  const { data } = await fetchBase64(url);
  writeFileSync(`${OUT}/ab-${tag}.png`, Buffer.from(data, 'base64'));
  console.log(`  ✅ ${label}: ${((Date.now() - t0) / 1000).toFixed(0)}s → ab-${tag}.png`);
  return url;
}

async function main() {
  if (!KEY || !process.env.REPLICATE_API_TOKEN) { console.error('need GEMINI_API_KEY + REPLICATE_API_TOKEN'); process.exit(1); }

  console.log('1. Style anchor (gpt-image-2, low)…');
  const anchorUrl = await gptImage('anchor', `${STYLE}, a friendly cartoon cat mascot, centered, plain background`, undefined, 'anchor');
  const anchorB64 = await fetchBase64(anchorUrl);

  console.log('\n2. PATH B — Gemini one-shot (anchor as style ref, no still)…');
  await omni('pathB', anchorB64,
    `In the exact ${STYLE} style of <IMAGE_REF_0>, ${SCENE}. Gentle ambient motion, falling leaves. Make it a ${DURATION}-second clip.`,
    'B-oneshot');

  console.log('\n3. PATH A — gpt-image-2 scene still → Gemini animate…');
  const stillUrl = await gptImage('scene still', `${STYLE}, ${SCENE}`, [anchorUrl], 'A-still');
  const stillB64 = await fetchBase64(stillUrl);
  await omni('pathA', stillB64,
    `Animate this image (<FIRST_FRAME>): gentle ambient motion, the cat breathes and blinks, leaves fall past the window. Make it a ${DURATION}-second clip.`,
    'A-animated');

  console.log('\nDone. Compare: ab-anchor.png (style), ab-B-oneshot.png (B), ab-A-still.png + ab-A-animated.png (A).');
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
