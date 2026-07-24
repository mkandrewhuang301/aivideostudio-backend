// Definitive check: does Omni actually generate 360p, and what's the REAL cost vs 720p?
// Generates the SAME 3s scene at 360p and 720p, reports accepted resolution, actual output
// dimensions, and OUTPUT VIDEO TOKENS (→ $ at $17.50/1M output tokens).
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeCheck360.ts
// env: GEMINI_API_KEY

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const KEY = process.env.GEMINI_API_KEY ?? '';
const OUT_TOKEN_PRICE = 17.5 / 1_000_000; // $/output token
const SCENE = 'a friendly cartoon cat waving in a bright meadow, gentle motion. Make it a 3-second clip.';

function findVideo(node: any): string | null {
  if (node && typeof node === 'object') {
    const mime = typeof node.mime_type === 'string' ? node.mime_type : '';
    if ((node.type === 'video' || mime.startsWith('video')) && typeof node.data === 'string') return node.data;
    for (const k of Object.keys(node)) { const f = findVideo(node[k]); if (f) return f; }
  }
  return null;
}
function videoTokens(usage: any): number | null {
  const arr = usage?.output_tokens_by_modality;
  const v = Array.isArray(arr) ? arr.find((m: any) => m.modality === 'video') : null;
  return v?.tokens ?? null;
}

async function gen(resolution: string) {
  const body = {
    model: 'gemini-omni-flash-preview',
    input: [{ type: 'text', text: SCENE }],
    response_format: { type: 'video', aspect_ratio: '16:9', resolution },
  };
  const t0 = Date.now();
  const res = await fetch(`${INTERACTIONS}?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const ms = ((Date.now() - t0) / 1000).toFixed(0);
  if (!res.ok) {
    console.log(`❌ ${resolution}: HTTP ${res.status} — ${JSON.stringify(await res.json()).slice(0, 240)}`);
    return;
  }
  const json: any = await res.json();
  const tok = videoTokens(json.usage);
  const b64 = findVideo(json);
  let dims = '?', dur = '?';
  if (b64) {
    const f = `${OUT}/check-${resolution}.mp4`;
    writeFileSync(f, Buffer.from(b64, 'base64'));
    try {
      const p = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration', '-of', 'csv=p=0', f]).toString().trim().split(',');
      dims = `${p[0]}x${p[1]}`; dur = p[2] ?? '?';
    } catch {}
  }
  const cost = tok != null ? (tok * OUT_TOKEN_PRICE) : null;
  const perSec = tok != null && dur !== '?' ? (tok / parseFloat(dur)) : null;
  console.log(`✅ ${resolution} (${ms}s): output=${dims}, dur=${dur}s, videoTokens=${tok}, ` +
    `$${cost?.toFixed(4)}/clip, ${perSec?.toFixed(0)} tok/sec = $${perSec ? (perSec * OUT_TOKEN_PRICE).toFixed(4) : '?'}/sec`);
}

async function main() {
  if (!KEY) { console.error('need GEMINI_API_KEY'); process.exit(1); }
  console.log('Generating same 3s scene at 360p and 720p…\n');
  await gen('360p');
  await gen('720p');
  console.log('\n(720p baseline known: 5,792 tok/sec = $0.10/sec. Compare 360p above.)');
}
main().catch((e) => { console.error('crashed:', e.message ?? e); process.exit(1); });
