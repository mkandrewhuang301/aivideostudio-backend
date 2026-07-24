// Rebuild the rabbit (photosynthesis) explainer with a FLAT, confident explainer voice (replacing
// the old "upbeat/enthusiastic" directive) + music nudged down to 0.06. Gemini-direct TTS (credits),
// since fal balance is exhausted. Keeps old rb-* files for A/B; writes rf-* + ~/Downloads copy.
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeRebuildFlat.ts [Voice]
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GKEY = process.env.GEMINI_API_KEY ?? '';
const OKEY = process.env.OPENAI_API_KEY ?? '';
const VOICE = process.argv[2] ?? 'Kore';
const MUSIC = `${OUT}/sim-music.mp3`;
const MUSIC_VOL = 0.06; // slightly under the old 0.08

// FLAT directive — the fix for "too empathetic".
const DIRECTIVE =
  'Narrate as a clear, confident explainer voice: calm, even, and matter-of-fact. ' +
  'Steady natural pace, neutral and informative. Do not sound emotional, excited, sing-songy, or overly warm. Just clearly explain:';

const SCENES = [
  { clip: 'n1-clip.mp4', text: 'Ever wonder how plants make their own food? Let me show you.' },
  { clip: 'n2-clip.mp4', text: 'It all starts with the sun. Plants soak up sunlight all day long.' },
  { clip: 'n3-clip.mp4', text: 'They mix that sunlight with water pulled up from their roots.' },
  { clip: 'n4-clip.mp4', text: "And that's photosynthesis, a plant's very own superpower." },
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
  if (!GKEY) { console.error('need GEMINI_API_KEY'); process.exit(1); }
  console.log(`Voice=${VOICE} | flat directive | music@${MUSIC_VOL}`);
  const sceneFiles: string[] = [];
  for (let i = 0; i < SCENES.length; i++) {
    const s = SCENES[i]!;
    const narr = `${OUT}/rf-narr${i}.mp3`;
    await tts(s.text, narr);
    const d = dur(narr);
    const scene = `${OUT}/rf-scene${i}.mp4`;
    sh('ffmpeg', ['-y', '-i', `${OUT}/${s.clip}`, '-i', narr,
      '-filter_complex', '[0:v]tpad=stop_mode=clone:stop_duration=15,fps=24,scale=1280:720[v]',
      '-map', '[v]', '-map', '1:a', '-t', String(d), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', scene]);
    sceneFiles.push(scene);
    console.log(`  scene${i}: ${d.toFixed(2)}s`);
  }
  const list = `${OUT}/rf-list.txt`; writeFileSync(list, sceneFiles.map((f) => `file '${f}'`).join('\n'));
  const concat = `${OUT}/rf-concat.mp4`; sh('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', concat]);
  const total = dur(concat);

  const audio = `${OUT}/rf-audio.mp3`; sh('ffmpeg', ['-y', '-i', concat, '-vn', '-q:a', '2', audio]);
  let srt = '';
  try {
    const w = await words(audio);
    let out = '', idx = 1;
    for (let i = 0; i < w.length; i += 4) { const g = w.slice(i, i + 4); if (!g.length) break; out += `${idx++}\n${srtTime(g[0].start)} --> ${srtTime(g[g.length - 1].end)}\n${g.map((x: any) => x.word).join(' ').trim()}\n\n`; }
    srt = `${OUT}/rf.srt`; writeFileSync(srt, out);
  } catch (e) { console.warn('  captions skipped:', (e as Error).message); srt = ''; }

  const fade = Math.max(0, total - 1.5);
  const withMusic = `${OUT}/rf-withmusic.mp4`;
  sh('ffmpeg', ['-y', '-i', concat, '-stream_loop', '-1', '-i', MUSIC, '-filter_complex',
    `[1:a]volume=${MUSIC_VOL},afade=t=out:st=${fade.toFixed(2)}:d=1.5[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', withMusic]);

  const final = `${OUT}/rf-flat-explainer.mp4`;
  if (srt) {
    sh('ffmpeg', ['-y', '-i', withMusic, '-vf', `subtitles=${srt}:force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=40'`, '-c:a', 'copy', final]);
  } else {
    copyFileSync(withMusic, final);
  }
  const dl = `${homedir()}/Downloads/rb-flat-explainer.mp4`;
  copyFileSync(final, dl);
  console.log(`\n✅ DONE (${total.toFixed(1)}s) → ${dl}`);
}
main().catch((e) => { console.error('crashed:', e.message ?? e); process.exit(1); });
