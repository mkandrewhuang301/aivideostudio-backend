// Generate an instrumental music bed and mix it UNDER the narration in the sim explainer, so the
// layered audio can be evaluated. PRIMARY: real Lyria 3 (Gemini API, same AI Studio key as Omni —
// `lyria-3-clip-preview`, 30s). FALLBACK: MusicGen on Replicate if Lyria 429s on the shared quota.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeMusic.ts
// env: GEMINI_API_KEY (Lyria), REPLICATE_API_TOKEN (fallback)

import 'dotenv/config';
import Replicate from 'replicate';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const SIM = `${OUT}/sim-final-explainer.mp4`;
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const PROMPT = 'A gentle, upbeat, playful instrumental for a friendly children\'s educational explainer — light xylophone, soft warm synth pads, cheerful and curious. Purely instrumental, no vocals.';

function toUrl(o: any): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v?.url && typeof v.url === 'function') return String(v.url());
  if (v?.url) return String(v.url);
  throw new Error('replicate: no output url');
}
function dur(f: string): number {
  return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', f]).toString().trim());
}
// Recursively find inline audio base64 in Lyria's `steps` response.
function findAudio(node: any): string | null {
  if (node && typeof node === 'object') {
    const mime = typeof node.mime_type === 'string' ? node.mime_type : '';
    if ((node.type === 'audio' || mime.startsWith('audio')) && typeof node.data === 'string') return node.data;
    for (const k of Object.keys(node)) { const f = findAudio(node[k]); if (f) return f; }
  }
  return null;
}

async function lyria(out: string): Promise<boolean> {
  const res = await fetch(INTERACTIONS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' },
    body: JSON.stringify({ model: 'lyria-3-clip-preview', input: PROMPT }),
  });
  if (!res.ok) { console.log(`Lyria HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`); return false; }
  const b64 = findAudio(await res.json());
  if (!b64) { console.log('Lyria: no inline audio found'); return false; }
  writeFileSync(out, Buffer.from(b64, 'base64'));
  return true;
}

async function musicgen(out: string) {
  const o = await replicate.run('meta/musicgen', {
    input: { prompt: PROMPT, duration: 20, model_version: 'stereo-large', output_format: 'mp3', normalization_strategy: 'loudness' },
  });
  writeFileSync(out, Buffer.from(await (await fetch(toUrl(o))).arrayBuffer()));
}

async function main() {
  const total = dur(SIM);
  const music = `${OUT}/sim-music.mp3`;
  const t0 = Date.now();

  console.log('trying real Lyria 3 (lyria-3-clip-preview)…');
  let src = 'Lyria 3';
  if (!(await lyria(music))) {
    console.log('→ falling back to MusicGen (Replicate)…');
    await musicgen(music);
    src = 'MusicGen (fallback)';
  }
  console.log(`music (${src}): ${((Date.now() - t0) / 1000).toFixed(0)}s → sim-music.mp3`);

  // Mix music UNDER narration: low volume, fade out at the end.
  const withMusic = `${OUT}/sim-with-music.mp4`;
  const fadeStart = Math.max(0, total - 1.5);
  execFileSync('ffmpeg', ['-y', '-i', SIM, '-i', music,
    '-filter_complex',
    `[1:a]volume=0.16,afade=t=out:st=${fadeStart.toFixed(2)}:d=1.5[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', withMusic],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(`\n✅ DONE → sim-with-music.mp4 (narration + captions + ${src} bed). Raw music: sim-music.mp3`);
}
main().catch((e) => { console.error('crashed:', e.message ?? e); process.exit(1); });
