// Test the cost strategy: does "360p Omni → AI-upscale" look as good as native 720p?
// Proxy (no Google quota needed): take a 720p clip → downscale to 360p → upscale via ByteDance →
// compare frames (native-720p vs 360p vs upscaled). Upscaler is on Replicate.
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeUpscale.ts [clipBasename]
// env: REPLICATE_API_TOKEN

import 'dotenv/config';
import Replicate from 'replicate';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const base = process.argv[2] ?? 'claymation-A-clip';
const SRC = `${OUT}/${base}.mp4`;

function toUrl(o: any): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v?.url && typeof v.url === 'function') return String(v.url());
  if (v?.url) return String(v.url);
  throw new Error('replicate: no output url');
}
function probe(f: string): string {
  try { return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim(); } catch { return '?'; }
}
function frame(f: string, out: string) {
  try { execFileSync('ffmpeg', ['-y', '-ss', '1.5', '-i', f, '-frames:v', '1', out]); } catch {}
}

async function main() {
  if (!process.env.REPLICATE_API_TOKEN) { console.error('need REPLICATE_API_TOKEN'); process.exit(1); }

  // 1. Downscale the 720p source to 360p (simulate a cheap native-360p Omni clip).
  const p360 = `${OUT}/up-360.mp4`;
  execFileSync('ffmpeg', ['-y', '-i', SRC, '-vf', 'scale=-2:360', '-c:a', 'copy', p360]);
  console.log(`source ${base}: ${probe(SRC)} | downscaled 360p: ${probe(p360)}`);

  // 2. Upload the 360p clip as a data URI + upscale it.
  const dataUri = `data:video/mp4;base64,${readFileSync(p360).toString('base64')}`;
  console.log('upscaling 360p → target 1080p via bytedance/video-upscaler …');
  const t0 = Date.now();
  let outUrl: string;
  try {
    const out = await replicate.run('bytedance/video-upscaler', { input: { video: dataUri, target_resolution: '1080p' } });
    outUrl = toUrl(out);
  } catch (e: any) {
    console.log('1080p target failed, retrying with no target_resolution (default):', String(e?.message ?? e).slice(0, 200));
    const out = await replicate.run('bytedance/video-upscaler', { input: { video: dataUri } });
    outUrl = toUrl(out);
  }
  const upscaled = `${OUT}/up-upscaled.mp4`;
  writeFileSync(upscaled, Buffer.from(await (await fetch(outUrl)).arrayBuffer()));
  const secs = (Date.now() - t0) / 1000;

  // 3. Frames for eyeball comparison.
  frame(SRC, `${OUT}/up-native720.png`);
  frame(p360, `${OUT}/up-360.png`);
  frame(upscaled, `${OUT}/up-upscaled.png`);

  console.log(`\nupscaled: ${probe(upscaled)} in ${secs.toFixed(0)}s → up-upscaled.mp4`);
  console.log('Compare frames: up-native720.png (expensive baseline) vs up-360.png (cheap) vs up-upscaled.png (cheap+upscaled).');
  console.log('Question: does up-upscaled look as good as up-native720? If yes, the 360p→upscale cost strategy holds.');
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
