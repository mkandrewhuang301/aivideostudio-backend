// SPIKE (throwaway) — Wan 2.6 I2V Flash (Replicate) as the Spanish-teacher CHEAP-tier candidate.
//   Arm A: native audio (audio_enabled: true) + the same verbatim-lock bilingual prompt as the
//          v3 winner — does Wan speak Spanish at all? board-text fidelity? occlusion drift?
//   Arm B: qwen Serena mixed-auto wav (12.96s) as the `audio` input → the lip-sync path.
//          Veo 3.1 (current cheap rung) has NO audio; Wan's audio-input sync would give the
//          cheap tier a lip-synced teacher driven by qwen TTS.
// Same gpt-image-2 still as spikeTeacherAB arm A. 720p, prompt expansion OFF (keep the raw
// verbatim-lock prompt, comparable to the v3 run).
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeWanFlashTeacher.ts
// env: REPLICATE_API_TOKEN

import 'dotenv/config';
import Replicate from 'replicate';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const OUT = `${process.env.HOME}/Downloads/spike-teacher-wanflash`;
const STILL = `${process.env.HOME}/Downloads/spike-teacher-ab/still-A-side-by-side.png`;
// Voice A CLONE (qwen voice_clone mode) — NOT a qwen prebuilt speaker. Andrew 7/24: the prebuilt
// defaults read Chinese-accented; teacher voice = clone (Voice A) or another non-default.
const AUDIO = `${process.env.HOME}/Downloads/spike-lesson-codeswitch/3-voiceA-mixed-auto.wav`; // 7.12s bilingual
const MODEL = 'wan-video/wan2.6-i2v-flash';

const SPOKEN = 'Hola. Today\'s word is manzana. Manzana means apple. Repeat after me: manzana.';
// Verbatim lock (same as spikeTeacherAB / the v3 winner): no ad-libs, audio must match exactly.
const PROMPT_A = 'A friendly Spanish teacher speaks directly to the camera in a calm, clear teaching voice. '
  + `She says these exact words and NOTHING else — no greeting beyond the script, no added sentences, `
  + `no improvised lines, no words after the last one: "${SPOKEN}". The spoken audio must match this line verbatim.`;
const PROMPT_B = 'A friendly Spanish teacher speaks directly to the camera in a calm, clear teaching voice, '
  + 'occasionally gesturing toward the whiteboard beside her. Her speech is provided as an audio file — '
  + 'synchronize her lip movement and delivery to that audio exactly; do not generate any other speech.';

const replicate = new Replicate();

// Wan derives the audio format from the URL's extension — Buffer/File/data-URI uploads all
// arrive extensionless and get rejected (''). Host the wav on R2 with a .wav key + presigned GET.
async function audioUrl(path: string): Promise<string> {
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  const Bucket = process.env.R2_BUCKET_NAME!;
  const Key = `spikes/wanflash/voiceA-mixed.wav`;
  await s3.send(new PutObjectCommand({
    Bucket, Key, Body: readFileSync(path), ContentType: 'audio/wav',
  }));
  return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
}

async function run(label: string, input: Record<string, unknown>): Promise<void> {
  console.log(`[${label}] creating prediction…`);
  const pred = await replicate.predictions.create({ model: MODEL, input });
  console.log(`[${label}] ${pred.id} — waiting…`);
  const done = await replicate.wait(pred);
  if (done.status !== 'succeeded') {
    console.error(`[${label}] ${done.status}: ${JSON.stringify(done.error ?? done.logs ?? '').slice(0, 500)}`);
    return;
  }
  const url = String(done.output);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`[${label}] fetch → ${r.status}`);
  const name = `${label}.mp4`;
  writeFileSync(`${OUT}/${name}`, Buffer.from(await r.arrayBuffer()));
  const t = done.metrics?.predict_time;
  console.log(`[${label}] ✓ ${name} (${t ? `${Math.round(t)}s gen` : 'gen time n/a'})`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // Image as data URI works; audio must be a URL ending in .wav (see audioUrl).
  const image = `data:image/png;base64,${readFileSync(STILL).toString('base64')}`;
  const audio = await audioUrl(AUDIO);
  console.log('audio hosted at', audio.slice(0, 90), '…');

  // Sequential — Replicate account was near the 429 burst throttle on 7/24 eve.
  // armA already succeeded (armA_native_audio.mp4 in OUT) — re-run armB only.
  if (!process.argv.includes('--armB-only')) {
    await run('armA_native_audio', {
      image,
      prompt: PROMPT_A,
      duration: 5,
      resolution: '720p',
      audio_enabled: true,
      enable_prompt_expansion: false,
    });
  }

  await run('armB_voiceA_lipsync', {
    image,
    audio,
    prompt: PROMPT_B,
    duration: 10, // enum 5/10/15; the Voice A clip is 7.12s
    resolution: '720p',
    audio_enabled: true,
    enable_prompt_expansion: false,
  });

  console.log('done — clips in', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
