// Inspect Omni's raw Interactions API response: pull the video out, save it, probe duration.
// Also probes DURATION CONTROL — pass a target and we see if the output length actually changes.
//
// Run: cd ~/aivideostudio-backend
//   npx tsx src/scripts/spikeOmniInspect.ts [durationSeconds] [text|leaf]
//   env: GEMINI_API_KEY, SPIKE_ANCHOR_URL (optional)

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const KEY = process.env.GEMINI_API_KEY!;
const URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const ANCHOR = process.env.SPIKE_ANCHOR_URL ?? 'https://picsum.photos/seed/explainer-anchor/1024/1024';
const OUT_DIR = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';

const durationArg = process.argv[2] ? Number(process.argv[2]) : undefined;
const sceneKind = process.argv[3] ?? 'leaf';

const SCENE_TEXT =
  sceneKind === 'text'
    ? 'a green chalkboard with the word PHOTOSYNTHESIS written clearly in white chalk, slow zoom in'
    : 'a single green leaf on a plant, warm morning sunlight streaming onto it, gentle slow camera push-in';

async function fetchBase64(u: string) {
  const r = await fetch(u);
  const mime = r.headers.get('content-type') ?? 'image/jpeg';
  return { data: Buffer.from(await r.arrayBuffer()).toString('base64'), mime };
}

// Recursively find the first node that looks like a returned video (inline base64 or a uri).
function findVideo(node: any, path = '$'): { path: string; data?: string; uri?: string; mime?: string } | null {
  if (node && typeof node === 'object') {
    const type = node.type;
    if (type === 'video' || node.mime_type?.startsWith?.('video') || node.mimeType?.startsWith?.('video')) {
      const data = node.data ?? node.bytes ?? node.b64_data;
      const uri = node.uri ?? node.url ?? node.file_uri ?? node.fileUri;
      if (data || uri) return { path, data, uri, mime: node.mime_type ?? node.mimeType };
    }
    for (const k of Object.keys(node)) {
      const found = findVideo(node[k], `${path}.${k}`);
      if (found) return found;
    }
  }
  return null;
}

async function main() {
  if (!KEY) { console.error('GEMINI_API_KEY missing'); process.exit(1); }
  const img = await fetchBase64(ANCHOR);

  const responseFormat: any = { type: 'video', aspect_ratio: '16:9' };
  // DURATION PROBE: if a target was passed, inject it two plausible ways and phrase it in text too.
  let durationNote = 'no duration requested';
  const promptText =
    durationArg !== undefined
      ? `In the exact art style of <IMAGE_REF_0>, show ${SCENE_TEXT}. Make it a ${durationArg}-second clip.`
      : `In the exact art style of <IMAGE_REF_0>, show ${SCENE_TEXT}.`;
  const body: any = {
    model: 'gemini-omni-flash-preview',
    input: [
      { type: 'image', data: img.data, mime_type: img.mime },
      { type: 'text', text: promptText },
    ],
    response_format: responseFormat,
  };
  if (durationArg !== undefined) {
    // `duration` param is REJECTED (400 Unknown parameter) — raw API has no typed duration field.
    // So the only lever left is prompt phrasing (already in promptText above). Optionally probe an
    // alternate param name via OMNI_DUR_FIELD (e.g. duration_seconds) without assuming it exists.
    const altField = process.env.OMNI_DUR_FIELD;
    if (altField) { responseFormat[altField] = durationArg; durationNote = `probing response_format.${altField}=${durationArg} + phrasing`; }
    else durationNote = `requested ${durationArg}s via PROMPT PHRASING ONLY (no typed param)`;
  }

  console.log(`scene=${sceneKind} | ${durationNote}\nPOST ${URL}\n`);
  const t0 = Date.now();
  const res = await fetch(`${URL}?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const json: any = await res.json();
  console.log(`HTTP ${res.status} in ${(ms / 1000).toFixed(1)}s | status=${json.status} | video_tokens=${json?.usage?.output_tokens_by_modality?.find?.((m: any) => m.modality === 'video')?.tokens ?? '?'}`);

  if (res.status !== 200) { console.log(JSON.stringify(json).slice(0, 1000)); return; }

  const vid = findVideo(json);
  if (!vid) {
    console.log('No video node found. Top-level keys:', Object.keys(json));
    writeFileSync(`${OUT_DIR}/omni-raw.json`, JSON.stringify(json, null, 2));
    console.log(`Raw response saved to ${OUT_DIR}/omni-raw.json for inspection.`);
    return;
  }

  console.log(`video found at ${vid.path} | mime=${vid.mime}`);
  const suffix = durationArg !== undefined ? `d${durationArg}` : 'nodur';
  const outFile = `${OUT_DIR}/omni-${sceneKind}-${suffix}.mp4`;
  if (vid.data) {
    const buf = Buffer.from(vid.data, 'base64');
    writeFileSync(outFile, buf);
    console.log(`saved ${(buf.length / 1024 / 1024).toFixed(2)} MB → ${outFile}`);
  } else if (vid.uri) {
    console.log(`video is a URI (needs Files API poll): ${vid.uri}`);
    return;
  }

  // Probe actual duration/resolution if ffprobe is available.
  try {
    const probe = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration,nb_frames,avg_frame_rate',
      '-of', 'default=noprint_wrappers=1', outFile,
    ]).toString();
    console.log('--- ffprobe ---\n' + probe.trim());
  } catch {
    console.log('(ffprobe not available — open the mp4 to check duration manually)');
  }
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
