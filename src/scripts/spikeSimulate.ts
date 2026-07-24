// End-to-end ASSEMBLY simulation (the half we never tested). Uses existing scene clips (Omni is
// quota-blocked) + real narration (OpenAI TTS, stand-in for Gemini TTS) + real word-timed captions
// (OpenAI whisper, stand-in for WhisperX) + ffmpeg stitch/mux/burn. Produces one final explainer mp4.
//
// Flow: per scene → TTS narration → size the clip to narration duration → build scene → concat all
// → transcribe narration → burn captions. (Music/Lyria omitted here — would be one more mux layer.)
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeSimulate.ts
// env: OPENAI_API_KEY

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const KEY = process.env.OPENAI_API_KEY!;
const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';

// The n1–n4 clips are a coherent cat-mascot "how plants eat" set — write matching narration.
const SCENES = [
  { clip: 'n1-clip.mp4', text: 'Ever wonder how plants make their own food? Let me show you.' },
  { clip: 'n2-clip.mp4', text: 'It all starts with the sun. Plants soak up sunlight all day long.' },
  { clip: 'n3-clip.mp4', text: 'They mix that sunlight with water pulled up from their roots.' },
  { clip: 'n4-clip.mp4', text: "And that's photosynthesis — a plant's very own superpower!" },
];

function sh(bin: string, args: string[]): string {
  return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}
function dur(f: string): number {
  return parseFloat(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', f]).trim());
}

async function tts(text: string, out: string) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', input: text, voice: 'nova', response_format: 'mp3' }),
  });
  if (!res.ok) throw new Error(`TTS failed ${res.status}: ${await res.text()}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

async function transcribeWords(audioPath: string): Promise<Array<{ word: string; start: number; end: number }>> {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(audioPath)], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form,
  });
  if (!res.ok) throw new Error(`transcribe failed ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return json.words ?? [];
}

function srtTime(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
// Group words into short caption cues (~4 words each).
function buildSrt(words: Array<{ word: string; start: number; end: number }>): string {
  const cues: string[] = [];
  let idx = 1;
  for (let i = 0; i < words.length; i += 4) {
    const grp = words.slice(i, i + 4);
    if (!grp.length) break;
    const start = grp[0]!.start, end = grp[grp.length - 1]!.end;
    cues.push(`${idx++}\n${srtTime(start)} --> ${srtTime(end)}\n${grp.map((w) => w.word).join(' ').trim()}\n`);
  }
  return cues.join('\n');
}

async function main() {
  if (!KEY) { console.error('need OPENAI_API_KEY'); process.exit(1); }

  const sceneFiles: string[] = [];
  for (let i = 0; i < SCENES.length; i++) {
    const s = SCENES[i]!;
    const narr = `${OUT}/sim-narr${i}.mp3`;
    await tts(s.text, narr);
    const d = dur(narr);
    // Size the existing clip to the narration duration: tpad clones the last frame to extend if the
    // narration is longer than the 3s clip; -t trims to exactly d. Mux the narration as the audio.
    const scene = `${OUT}/sim-scene${i}.mp4`;
    sh('ffmpeg', ['-y', '-i', `${OUT}/${s.clip}`, '-i', narr,
      '-filter_complex', '[0:v]tpad=stop_mode=clone:stop_duration=15,fps=24,scale=1280:720[v]',
      '-map', '[v]', '-map', '1:a', '-t', String(d), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', scene]);
    sceneFiles.push(scene);
    console.log(`scene ${i}: narration ${d.toFixed(1)}s → sim-scene${i}.mp4`);
  }

  // Concat the scenes.
  const list = `${OUT}/sim-list.txt`;
  writeFileSync(list, sceneFiles.map((f) => `file '${f}'`).join('\n'));
  const concat = `${OUT}/sim-concat.mp4`;
  sh('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', concat]);
  console.log(`concat → ${dur(concat).toFixed(1)}s total`);

  // Transcribe the assembled narration → word-timed captions → burn.
  const audio = `${OUT}/sim-audio.mp3`;
  sh('ffmpeg', ['-y', '-i', concat, '-vn', '-q:a', '2', audio]);
  const words = await transcribeWords(audio);
  const srt = `${OUT}/sim.srt`;
  writeFileSync(srt, buildSrt(words));
  console.log(`captions: ${words.length} words → sim.srt`);

  const final = `${OUT}/sim-final-explainer.mp4`;
  sh('ffmpeg', ['-y', '-i', concat, '-vf',
    `subtitles=${srt}:force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=40'`,
    '-c:a', 'copy', final]);
  console.log(`\n✅ DONE → sim-final-explainer.mp4 (${dur(final).toFixed(1)}s, narrated + captioned, 4 scenes)`);
}
main().catch((e) => { console.error('crashed:', e.message ?? e); process.exit(1); });
