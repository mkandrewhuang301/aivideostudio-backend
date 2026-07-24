// Rebuild rb-customwav so the SCENE VISUALS are timed to the provided narration wav (not old Paul
// timings) and the concat is re-encoded (no copy-concat flash). Continuous wav stays as the audio.
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeCustomSync.ts
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const HOME = homedir();
const D = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const WAV = `${HOME}/Downloads/replicate-prediction-8fvnz6a5j9rmw0czgxg9vv8jwc.wav`;
const MUSIC = `${D}/sim-music.mp3`;
const OUT = `${HOME}/Downloads/rb-customwav-cc.mp4`;
const SRT = `${D}/custom.srt`;
const OKEY = process.env.OPENAI_API_KEY ?? '';
const MUSIC_VOL = 0.10;
const SPEED = 1.1;        // narration speed-up (pitch preserved)
const MAX_STRETCH = 1.4;  // how much a clip may be slowed to cover its scene before we freeze the rest
const MAX_CUE = 6;        // max words per caption cue
const CLIPS = ['n1-clip.mp4', 'n2-clip.mp4', 'n3-clip.mp4', 'n4-clip.mp4'];
// Words a cue should never END on (they belong with what follows) — articles, conjunctions,
// prepositions, possessives. This is the general fix for the awkward "…a plant's" break.
const BAD_TRAILING = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'with', 'that', 'this',
  'their', 'his', 'her', 'its', 'our', 'your', 'my', 'in', 'on', 'for', 'at', 'from', 'up', 'into', 'over', 'very']);

// The spoken script WITH punctuation — cues break on commas & sentence ends first (natural phrasing).
const SCRIPT_PUNCT = "Ever wonder how plants make their own food? Let me show you. It all starts with the sun. Plants soak up sunlight all day long. They mix that sunlight with water pulled up from their roots. And that's photosynthesis, a plant's very own superpower.";

// sentences -> which scene each belongs to (scene0 = sentences 0,1; scene1 = 2,3; scene2 = 4; scene3 = 5)
const SENTENCES = [
  'Ever wonder how plants make their own food',
  'Let me show you',
  'It all starts with the sun',
  'Plants soak up sunlight all day long',
  'They mix that sunlight with water pulled up from their roots',
  "And that's photosynthesis a plant's very own superpower",
];
const SCENE_LAST_SENTENCE = [1, 3, 4, 5]; // last sentence index in each scene

function sh(bin: string, args: string[]) { execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
function dur(f: string): number { return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', f]).toString().trim()); }
function srtTime(s: number) { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), c = Math.floor(s % 60), ms = Math.round(s % 1 * 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(c).padStart(2, '0')},${String(ms).padStart(3, '0')}`; }
async function words(audio: string) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(audio)], { type: 'audio/wav' }), 'a.wav');
  form.append('model', 'whisper-1'); form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'word');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${OKEY}` }, body: form });
  const j: any = await res.json(); return j.words ?? [];
}

async function main() {
  const wavDur = dur(WAV) / SPEED;          // output (sped-up) length
  const raw = await words(WAV);
  const w = raw.map((x: any) => ({ word: x.word, start: x.start / SPEED, end: x.end / SPEED })); // rescale to sped-up time
  // cumulative last-word index for each sentence
  const sentEnd: number[] = []; let cum = 0;
  for (const s of SENTENCES) { cum += s.trim().split(/\s+/).length; sentEnd.push(cum - 1); }
  if (w.length !== cum) console.warn(`  drift: whisper ${w.length} vs script ${cum}`);
  // scene boundary times (end of scene's last sentence); last scene extends to wav end
  const sceneEnd = SCENE_LAST_SENTENCE.map((si, i) => (i === SCENE_LAST_SENTENCE.length - 1 ? wavDur : (w[sentEnd[si]!]?.end ?? wavDur)));
  const durs = sceneEnd.map((t, i) => +(t - (i === 0 ? 0 : sceneEnd[i - 1]!)).toFixed(3));
  console.log('scene durations:', durs.join(', '));

  // ---- captions: clause-aware (break on commas/sentence-ends), sub-split long clauses evenly,
  //      never ending a non-final cue on a function word ----
  const isBad = (s: string) => BAD_TRAILING.has(s.toLowerCase().replace(/[^a-z']/g, ''));
  const clauseLens = SCRIPT_PUNCT.split(/(?<=[,.?!;:])\s+/)
    .map((c) => c.trim().replace(/[,.?!;:]+$/, '').trim())
    .filter(Boolean)
    .map((c) => c.split(/\s+/).length);
  const clauseTotal = clauseLens.reduce((a, b) => a + b, 0);
  if (clauseTotal !== w.length) console.warn(`  caption drift: clauses ${clauseTotal} vs whisper ${w.length}`);

  const cues: Array<[number, number]> = [];
  let cursor = 0;
  for (const clen of clauseLens) {
    let remaining = clen, pieces = Math.ceil(clen / MAX_CUE), s = cursor;
    while (pieces > 0) {
      let e = s + Math.ceil(remaining / pieces) - 1;          // balanced piece size
      if (pieces > 1) while (e > s && isBad(w[e].word)) e -= 1; // don't end this cue on a function word
      cues.push([s, e]);
      remaining -= (e - s + 1); s = e + 1; pieces -= 1;
    }
    cursor += clen;
  }

  let srt = '';
  cues.forEach(([s, e], i) => {
    srt += `${i + 1}\n${srtTime(w[s].start)} --> ${srtTime(w[e].end)}\n${w.slice(s, e + 1).map((x: any) => x.word).join(' ').trim()}\n\n`;
  });
  writeFileSync(SRT, srt);
  console.log(`captions: ${cues.length} cues`);

  const clipDur = CLIPS.map((c) => dur(`${D}/${c}`));
  // per scene: stretch the clip to EXACTLY cover its scene (no frozen tail). Motion keeps moving
  // the whole time; the tradeoff is per-scene slow-motion (spike artifact — real Omni/Ken-Burns
  // clips are generated at the right length, so no stretch needed).
  const vparts = durs.map((d, i) => {
    const factor = +(d / clipDur[i]!).toFixed(4);
    return `[${i}:v]fps=24,scale=1280:720,setsar=1,setpts=${factor}*PTS,trim=0:${d},setpts=PTS-STARTPTS[v${i}]`;
  });
  console.log('stretch per scene:', durs.map((d, i) => (d / clipDur[i]!).toFixed(2) + 'x').join(', '), '(no freeze)');

  const inputs: string[] = [];
  CLIPS.forEach((c) => inputs.push('-i', `${D}/${c}`));
  inputs.push('-i', WAV, '-stream_loop', '-1', '-i', MUSIC);
  const concat = `${durs.map((_, i) => `[v${i}]`).join('')}concat=n=${durs.length}:v=1:a=0[vc]`;
  const cap = `[vc]subtitles=${SRT}:force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=40'[vout]`;
  const fade = Math.max(0, wavDur - 1.5);
  const na = CLIPS.length, ma = CLIPS.length + 1;
  const aud = `[${na}:a]atempo=${SPEED},volume=1.0[n];[${ma}:a]volume=${MUSIC_VOL},afade=t=out:st=${fade.toFixed(2)}:d=1.5[m];[n][m]amix=inputs=2:duration=first:normalize=0[a]`;
  const fc = [...vparts, concat, cap, aud].join(';');
  sh('ffmpeg', ['-y', ...inputs, '-filter_complex', fc, '-map', '[vout]', '-map', '[a]', '-t', String(wavDur),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', OUT]);
  console.log(`✅ ${OUT} (${wavDur.toFixed(1)}s @ ${SPEED}x)`);
}
main().catch((e) => { console.error('crashed:', e.message ?? e); process.exit(1); });
