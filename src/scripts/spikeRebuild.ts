// Rebuild the explainer with the REAL energetic Gemini voice (Puck) + quieter Lyria music.
// Per-scene Gemini TTS (energetic directive) → re-time each clip to its narration → concat →
// mux existing Lyria bed at LOW volume (0.08) → fresh whisper captions → final.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeRebuild.ts [VoiceName]
// env: GEMINI_API_KEY (TTS), OPENAI_API_KEY (captions)

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GKEY = process.env.GEMINI_API_KEY ?? '';
const OKEY = process.env.OPENAI_API_KEY ?? '';
const VOICE = process.argv[2] ?? 'Puck';
const MUSIC = `${OUT}/sim-music.mp3`; // reuse the Lyria bed already generated
const DIRECTIVE = 'Narrate with upbeat, enthusiastic energy like a fun, engaging explainer host — lively, warm, a little playful (NOT a slow calm audiobook):';

const SCENES = [
  { clip: 'n1-clip.mp4', text: 'Ever wonder how plants make their own food? Let me show you!' },
  { clip: 'n2-clip.mp4', text: 'It all starts with the sun — plants soak up sunlight all day long.' },
  { clip: 'n3-clip.mp4', text: 'They mix that sunlight with water pulled up from their roots.' },
  { clip: 'n4-clip.mp4', text: "And that's photosynthesis — a plant's very own superpower!" },
];

function sh(bin: string, args: string[]) { execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
function dur(f: string): number { return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', f]).toString().trim()); }
function findAudio(n: any): string | null {
  if (n && typeof n === 'object') {
    const m = typeof n.mime_type === 'string' ? n.mime_type : '';
    if ((n.type === 'audio' || m.startsWith('audio')) && typeof n.data === 'string') return n.data;
    for (const k of Object.keys(n)) { const f = findAudio(n[k]); if (f) return f; }
  }
  return null;
}
async function tts(text: string, outMp3: string) {
  const res = await fetch(INTERACTIONS, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GKEY },
    body: JSON.stringify({ model: 'gemini-3.1-flash-tts-preview', input: `${DIRECTIVE} ${text}`, response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: VOICE }] } }),
  });
  if (!res.ok) throw new Error(`TTS ${VOICE} ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const b64 = findAudio(await res.json());
  if (!b64) throw new Error('no audio');
  const pcm = outMp3.replace('.mp3', '.pcm');
  writeFileSync(pcm, Buffer.from(b64, 'base64'));
  sh('ffmpeg', ['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, outMp3]);
}
async function words(audio: string) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(audio)], { type: 'audio/mpeg' }), 'a.mp3');
  form.append('model', 'whisper-1'); form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'word');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${OKEY}` }, body: form });
  const j: any = await res.json(); return j.words ?? [];
}
function srtTime(s: number) { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), c = Math.floor(s % 60), ms = Math.round(s % 1 * 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(c).padStart(2, '0')},${String(ms).padStart(3, '0')}`; }

async function main() {
  if (!GKEY || !OKEY) { console.error('need GEMINI_API_KEY + OPENAI_API_KEY'); process.exit(1); }
  const sceneFiles: string[] = [];
  for (let i = 0; i < SCENES.length; i++) {
    const s = SCENES[i]!;
    const narr = `${OUT}/rb-narr${i}.mp3`;
    await tts(s.text, narr);
    const d = dur(narr);
    const scene = `${OUT}/rb-scene${i}.mp4`;
    sh('ffmpeg', ['-y', '-i', `${OUT}/${s.clip}`, '-i', narr,
      '-filter_complex', '[0:v]tpad=stop_mode=clone:stop_duration=15,fps=24,scale=1280:720[v]',
      '-map', '[v]', '-map', '1:a', '-t', String(d), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', scene]);
    sceneFiles.push(scene);
    console.log(`scene ${i} (${VOICE}): ${d.toFixed(1)}s`);
  }
  const list = `${OUT}/rb-list.txt`; writeFileSync(list, sceneFiles.map((f) => `file '${f}'`).join('\n'));
  const concat = `${OUT}/rb-concat.mp4`; sh('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', concat]);
  const total = dur(concat);

  const audio = `${OUT}/rb-audio.mp3`; sh('ffmpeg', ['-y', '-i', concat, '-vn', '-q:a', '2', audio]);
  const w = await words(audio);
  const srt = `${OUT}/rb.srt`;
  let out = '', idx = 1;
  for (let i = 0; i < w.length; i += 4) { const g = w.slice(i, i + 4); if (!g.length) break; out += `${idx++}\n${srtTime(g[0].start)} --> ${srtTime(g[g.length - 1].end)}\n${g.map((x: any) => x.word).join(' ').trim()}\n\n`; }
  writeFileSync(srt, out);

  // Mux Lyria music at LOW volume (0.08) under narration, faded out; burn captions.
  const withMusic = `${OUT}/rb-withmusic.mp4`; const fade = Math.max(0, total - 1.5);
  sh('ffmpeg', ['-y', '-i', concat, '-i', MUSIC, '-filter_complex',
    `[1:a]volume=0.08,afade=t=out:st=${fade.toFixed(2)}:d=1.5[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', withMusic]);
  const final = `${OUT}/rb-final-explainer.mp4`;
  sh('ffmpeg', ['-y', '-i', withMusic, '-vf', `subtitles=${srt}:force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=40'`, '-c:a', 'copy', final]);
  console.log(`\n✅ DONE → rb-final-explainer.mp4 (${VOICE} energetic voice + music@0.08 + captions)`);
}
main().catch((e) => { console.error('crashed:', e.message ?? e); process.exit(1); });
