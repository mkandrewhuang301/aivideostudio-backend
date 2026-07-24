// Rebuild the rabbit (photosynthesis) explainer with ElevenLabs v3 via Replicate (uses the
// existing REPLICATE_API_TOKEN — no ElevenLabs key needed). Tuned FLAT: high stability, style 0.
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeRebuildV3.ts [voice] [stability]
// env: REPLICATE_API_TOKEN, OPENAI_API_KEY (captions)
import 'dotenv/config';
import Replicate from 'replicate';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const OKEY = process.env.OPENAI_API_KEY ?? '';
const MUSIC = `${OUT}/sim-music.mp3`;
const MUSIC_VOL = 0.10;
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const VOICE = process.argv[2] ?? 'Paul';
const STABILITY = process.argv[3] ? parseFloat(process.argv[3]) : 0.7; // higher = flatter/less emotive

const SCENES = [
  { clip: 'n1-clip.mp4', text: 'Ever wonder how plants make their own food? Let me show you.' },
  { clip: 'n2-clip.mp4', text: 'It all starts with the sun. Plants soak up sunlight all day long.' },
  { clip: 'n3-clip.mp4', text: 'They mix that sunlight with water pulled up from their roots.' },
  { clip: 'n4-clip.mp4', text: "And that's photosynthesis, a plant's very own superpower." },
];

function sh(bin: string, args: string[]) { execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
function dur(f: string): number { return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', f]).toString().trim()); }
function toUrl(o: any): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v?.url && typeof v.url === 'function') return String(v.url());
  if (v?.url) return String(v.url);
  throw new Error('replicate: no output url');
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function tts(i: number, outMp3: string) {
  const input = {
    prompt: SCENES[i]!.text,
    voice: VOICE,
    stability: STABILITY,
    style: 0,
    similarity_boost: 0.75,
    speed: 1,
    previous_text: i > 0 ? SCENES[i - 1]!.text : '',
    next_text: i < SCENES.length - 1 ? SCENES[i + 1]!.text : '',
  };
  let out: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { out = await replicate.run('elevenlabs/v3', { input }); break; }
    catch (e: any) {
      const msg = String(e?.message ?? e);
      const wait = (e?.response?.headers?.get?.('retry-after') ?? 12) as number;
      if (msg.includes('429') && attempt < 7) { console.log(`    throttled, waiting ${wait}s…`); await sleep((Number(wait) || 12) * 1000 + 1000); continue; }
      throw e;
    }
  }
  const res = await fetch(toUrl(out));
  if (!res.ok) throw new Error(`download scene${i} ${res.status}`);
  writeFileSync(outMp3, Buffer.from(await res.arrayBuffer()));
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
  const vlow = VOICE.toLowerCase();
  console.log(`ElevenLabs v3 (Replicate) voice=${VOICE} | stability=${STABILITY} style=0 | music@${MUSIC_VOL}`);
  const sceneFiles: string[] = [];
  for (let i = 0; i < SCENES.length; i++) {
    const narr = `${OUT}/v3-narr${i}.mp3`;
    await tts(i, narr);
    const d = dur(narr);
    const scene = `${OUT}/v3-scene${i}.mp4`;
    sh('ffmpeg', ['-y', '-i', `${OUT}/${SCENES[i]!.clip}`, '-i', narr,
      '-filter_complex', '[0:v]tpad=stop_mode=clone:stop_duration=15,fps=24,scale=1280:720[v]',
      '-map', '[v]', '-map', '1:a', '-t', String(d), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', scene]);
    sceneFiles.push(scene);
    console.log(`  scene${i}: ${d.toFixed(2)}s`);
  }
  const list = `${OUT}/v3-list.txt`; writeFileSync(list, sceneFiles.map((f) => `file '${f}'`).join('\n'));
  const concat = `${OUT}/v3-concat.mp4`; sh('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', concat]);
  const total = dur(concat);
  const audio = `${OUT}/v3-audio.mp3`; sh('ffmpeg', ['-y', '-i', concat, '-vn', '-q:a', '2', audio]);
  let srt = '';
  try {
    const w = await words(audio); let out = '', idx = 1;
    for (let i = 0; i < w.length; i += 4) { const g = w.slice(i, i + 4); if (!g.length) break; out += `${idx++}\n${srtTime(g[0].start)} --> ${srtTime(g[g.length - 1].end)}\n${g.map((x: any) => x.word).join(' ').trim()}\n\n`; }
    srt = `${OUT}/v3.srt`; writeFileSync(srt, out);
  } catch (e) { console.warn('  captions skipped:', (e as Error).message); }
  const fade = Math.max(0, total - 1.5);
  const withMusic = `${OUT}/v3-withmusic.mp4`;
  sh('ffmpeg', ['-y', '-i', concat, '-stream_loop', '-1', '-i', MUSIC, '-filter_complex',
    `[1:a]volume=${MUSIC_VOL},afade=t=out:st=${fade.toFixed(2)}:d=1.5[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', withMusic]);
  const final = `${OUT}/v3-${vlow}-explainer.mp4`;
  if (srt) sh('ffmpeg', ['-y', '-i', withMusic, '-vf', `subtitles=${srt}:force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=40'`, '-c:a', 'copy', final]);
  else copyFileSync(withMusic, final);
  const dl = `${homedir()}/Downloads/rb-v3-${vlow}.mp4`;
  copyFileSync(final, dl);
  console.log(`\n✅ DONE (${total.toFixed(1)}s) → ${dl}`);
}
main().catch((e) => { console.error('crashed:', e.message ?? e); process.exit(1); });
