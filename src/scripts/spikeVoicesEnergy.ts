// Retest Gemini TTS with an explicit ENERGETIC explainer-host style directive (the first pass had
// no style steer → sounded like an audiobook). Tests whether the "no passion / too slow" problem is
// Gemini's ceiling or just an un-prompted default, before deciding to switch to ElevenLabs.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeVoicesEnergy.ts
// env: GEMINI_API_KEY

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
// Style directive prepended to steer delivery — upbeat, lively explainer host, not audiobook.
const DIRECTIVE =
  'Narrate with upbeat, enthusiastic energy like a fun, engaging explainer host — lively pace, warm, curious, a little playful (NOT a slow calm audiobook):';
const NARRATION =
  'Ever wonder how plants make their own food? Let me show you! ' +
  'It all starts with the sun — plants soak up sunlight all day long. ' +
  'They mix that sunlight with water pulled up from their roots. ' +
  "And that's photosynthesis — a plant's very own superpower!";

// The brighter/punchier voices to try with energy (skip Charon — too deep/slow).
const VOICES = ['Puck', 'Aoede', 'Kore', 'Leda'];

function findAudio(node: any): string | null {
  if (node && typeof node === 'object') {
    const mime = typeof node.mime_type === 'string' ? node.mime_type : '';
    if ((node.type === 'audio' || mime.startsWith('audio')) && typeof node.data === 'string') return node.data;
    for (const k of Object.keys(node)) { const f = findAudio(node[k]); if (f) return f; }
  }
  return null;
}

async function voice(name: string): Promise<boolean> {
  const res = await fetch(INTERACTIONS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' },
    body: JSON.stringify({
      model: 'gemini-3.1-flash-tts-preview',
      input: `${DIRECTIVE} ${NARRATION}`,
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: name }] },
    }),
  });
  if (!res.ok) { console.log(`  ${name}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`); return false; }
  const b64 = findAudio(await res.json());
  if (!b64) { console.log(`  ${name}: no audio`); return false; }
  const pcm = `${OUT}/energy-${name}.pcm`;
  writeFileSync(pcm, Buffer.from(b64, 'base64'));
  execFileSync('ffmpeg', ['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, `${OUT}/energy-${name}.mp3`], { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(`  ✅ ${name} → energy-${name}.mp3`);
  return true;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) { console.error('need GEMINI_API_KEY'); process.exit(1); }
  const ok: string[] = [];
  for (const v of VOICES) { if (await voice(v)) ok.push(v); }
  console.log(`\nDone. Compare to the flat originals: ${ok.map((v) => `energy-${v}.mp3`).join(', ')}`);
}
main().catch((e) => { console.error('crashed:', e.message ?? e); process.exit(1); });
