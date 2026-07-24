// Audio spike: can Omni do "sound effects only, NO music" via prompt? Two atmospheric scenes
// (where a model would be tempted to add music) with an explicit no-music instruction. Keeps the
// audio track — open the mp4s and LISTEN. If it's clean diegetic SFX with no music sneaking in,
// the layered audio plan (Omni SFX + Lyria music + TTS) is viable.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeSfx.ts
// env: GEMINI_API_KEY

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const KEY = process.env.GEMINI_API_KEY!;
const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';

const NO_MUSIC = 'Ambient diegetic sound effects only — the natural sounds of the scene. Absolutely NO music, no soundtrack, no background score, no melody. Make it a 5-second clip.';

const SCENES = [
  { tag: 'sfx-campfire', text: `a crackling campfire in a dark forest at night, glowing embers and sparks rising. ${NO_MUSIC}` },
  { tag: 'sfx-rain',     text: `heavy rain streaming down a window at night, blurry warm city lights beyond, an occasional distant thunder rumble. ${NO_MUSIC}` },
  { tag: 'sfx-kitchen',  text: `a busy cafe: espresso machine hissing, cups clinking, low crowd murmur. ${NO_MUSIC}` },
];

function findVideo(node: any): { data?: string } | null {
  if (node && typeof node === 'object') {
    if ((node.type === 'video' || node.mime_type?.startsWith?.('video')) && node.data) return { data: node.data };
    for (const k of Object.keys(node)) { const f = findVideo(node[k]); if (f) return f; }
  }
  return null;
}

async function main() {
  if (!KEY) { console.error('need GEMINI_API_KEY'); process.exit(1); }
  for (const s of SCENES) {
    const body = {
      model: 'gemini-omni-flash-preview',
      input: [{ type: 'text', text: s.text }],
      response_format: { type: 'video', aspect_ratio: '16:9' },
    };
    const t0 = Date.now();
    const res = await fetch(`${INTERACTIONS}?key=${KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json: any = await res.json();
    if (res.status !== 200) { console.log(`${s.tag} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`); continue; }
    const vid = findVideo(json);
    if (!vid?.data) { console.log(`${s.tag}: no video`); continue; }
    const file = `${OUT}/${s.tag}.mp4`;
    writeFileSync(file, Buffer.from(vid.data, 'base64'));
    // Report audio stream details so we know sound is actually present before listening.
    let audio = '?';
    try { audio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels,sample_rate,duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]).toString().trim().replace(/\n/g, ' '); } catch { audio = 'no audio stream'; }
    console.log(`✅ ${s.tag}: ${((Date.now() - t0) / 1000).toFixed(0)}s → ${s.tag}.mp4 | audio: ${audio}`);
  }
  console.log('\nDone. Open + LISTEN to sfx-campfire / sfx-rain / sfx-kitchen .mp4 — clean SFX? any music sneaking in?');
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
