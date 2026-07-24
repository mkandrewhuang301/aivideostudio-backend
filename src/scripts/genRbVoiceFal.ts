// Regenerate the rabbit (photosynthesis) explainer voiceover via FAL Gemini TTS with a FLAT,
// confident explainer directive (replacing the old "upbeat/enthusiastic" one that read too emotive).
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/genRbVoiceFal.ts [Voice]
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { falRunTts } from '../services/providers/FalProvider';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const MODEL = 'fal-ai/gemini-3.1-flash-tts';
const VOICE = process.argv[2] ?? 'Kore';

// NEW directive — flat, confident, informative. No enthusiasm, no sing-song.
const DIRECTIVE =
  'Narrate as a clear, confident explainer voice: calm, even, and matter-of-fact. ' +
  'Steady natural pace, neutral and informative. Do not sound emotional, excited, sing-songy, or overly warm. ' +
  'Just clearly explain:';

const SCENES = [
  'Ever wonder how plants make their own food? Let me show you.',
  'It all starts with the sun. Plants soak up sunlight all day long.',
  'They mix that sunlight with water pulled up from their roots.',
  "And that's photosynthesis, a plant's very own superpower.",
];

function dur(f: string): number {
  return parseFloat(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', f]).toString().trim(),
  );
}

async function main() {
  console.log(`Voice=${VOICE}  directive="${DIRECTIVE.slice(0, 40)}…"`);
  for (let i = 0; i < SCENES.length; i += 1) {
    const url = await falRunTts(MODEL, { prompt: `${DIRECTIVE} ${SCENES[i]}`, voice: VOICE, output_format: 'wav' } as never);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download scene${i} failed ${res.status}`);
    const out = `${OUT}/rb2-narr${i}.wav`;
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log(`  scene${i}: ${dur(out).toFixed(2)}s  ${out}`);
  }
  console.log('done');
}
main().catch((e) => { console.error(e); process.exit(1); });
