// Auto-caption rb-customwav.mp4 with the same method the explainer pipeline uses:
// Whisper word-timestamps -> short cues -> burned subtitles.
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/capCustom.ts
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const OKEY = process.env.OPENAI_API_KEY ?? '';
const HOME = homedir();
const WAV = `${HOME}/Downloads/replicate-prediction-8fvnz6a5j9rmw0czgxg9vv8jwc.wav`; // clean narration
const VIDEO = `${HOME}/Downloads/rb-customwav.mp4`;
const OUTV = `${HOME}/Downloads/rb-customwav-cc.mp4`;
const SRT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad/custom.srt';

function sh(bin: string, args: string[]) { execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
async function words(audio: string) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(audio)], { type: 'audio/wav' }), 'a.wav');
  form.append('model', 'whisper-1'); form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'word');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${OKEY}` }, body: form });
  const j: any = await res.json(); return j.words ?? [];
}
function srtTime(s: number) { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), c = Math.floor(s % 60), ms = Math.round(s % 1 * 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(c).padStart(2, '0')},${String(ms).padStart(3, '0')}`; }

// The spoken script, split into SENTENCES — cues never cross these boundaries (mirrors the
// pipeline's per-scene cueing, so "…the sun." and "Plants soak up…" stay separate).
const SENTENCES = [
  'Ever wonder how plants make their own food',
  'Let me show you',
  'It all starts with the sun',
  'Plants soak up sunlight all day long',
  'They mix that sunlight with water pulled up from their roots',
  "And that's photosynthesis a plant's very own superpower",
];
const MAX_WORDS = 4;

async function main() {
  if (!OKEY) { console.error('need OPENAI_API_KEY'); process.exit(1); }
  const w = await words(WAV);
  // break-after indices: last word of each sentence (by cumulative word count)
  const breakAfter = new Set<number>();
  let cum = 0;
  for (const s of SENTENCES) { cum += s.trim().split(/\s+/).length; breakAfter.add(cum - 1); }
  console.log(`whisper words=${w.length} script words=${cum}${w.length !== cum ? ' (drift — check alignment)' : ''}`);

  let out = '', idx = 1, cur: any[] = [];
  for (let i = 0; i < w.length; i += 1) {
    cur.push(w[i]);
    if (cur.length >= MAX_WORDS || breakAfter.has(i) || i === w.length - 1) {
      out += `${idx++}\n${srtTime(cur[0].start)} --> ${srtTime(cur[cur.length - 1].end)}\n${cur.map((x: any) => x.word).join(' ').trim()}\n\n`;
      cur = [];
    }
  }
  writeFileSync(SRT, out);
  console.log(`captions: ${idx - 1} cues`);
  sh('ffmpeg', ['-y', '-i', VIDEO, '-vf',
    `subtitles=${SRT}:force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=40'`,
    '-c:a', 'copy', OUTV]);
  console.log(`✅ ${OUTV}`);
}
main().catch((e) => { console.error('crashed:', e.message ?? e); process.exit(1); });
