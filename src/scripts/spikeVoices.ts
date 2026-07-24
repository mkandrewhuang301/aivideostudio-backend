// Generate the sim narration in several real Gemini TTS voices so a good product voice can be
// picked (the sim used OpenAI tts-1 as a throwaway stand-in). Same AI Studio key, interactions API.
// Output: base64 PCM (24kHz mono 16-bit) → wrapped to mp3 per voice.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeVoices.ts
// env: GEMINI_API_KEY

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const NARRATION =
  'Ever wonder how plants make their own food? Let me show you. ' +
  'It all starts with the sun — plants soak up sunlight all day long. ' +
  'They mix that sunlight with water pulled up from their roots. ' +
  "And that's photosynthesis — a plant's very own superpower!";

// A spread: warm/firm female, breezy female, upbeat male, deeper informative male.
const VOICES = ['Kore', 'Aoede', 'Puck', 'Charon'];

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
      input: NARRATION,
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: name }] },
    }),
  });
  if (!res.ok) { console.log(`  ${name}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`); return false; }
  const b64 = findAudio(await res.json());
  if (!b64) { console.log(`  ${name}: no audio`); return false; }
  // base64 → raw PCM (s16le 24kHz mono) → mp3 via ffmpeg.
  const pcm = `${OUT}/voice-${name}.pcm`;
  writeFileSync(pcm, Buffer.from(b64, 'base64'));
  execFileSync('ffmpeg', ['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, `${OUT}/voice-${name}.mp3`], { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(`  ✅ ${name} → voice-${name}.mp3`);
  return true;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) { console.error('need GEMINI_API_KEY'); process.exit(1); }
  const ok: string[] = [];
  for (const v of VOICES) { if (await voice(v)) ok.push(v); }
  console.log(`\nDone. Listen to: ${ok.map((v) => `voice-${v}.mp3`).join(', ') || '(none — quota?)'}`);
}
main().catch((e) => { console.error('crashed:', e.message ?? e); process.exit(1); });
