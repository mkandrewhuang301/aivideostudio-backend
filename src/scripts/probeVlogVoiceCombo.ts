// One-off probe (Andrew, 2026-07-25): is first-frame `image` + `reference_audios` REALLY
// rejected by Seedance 2.0 Mini, or was the smoke's E006 circumstantial? Minimum spend:
// 4s (schema floor), 480p (falls back to 720p if the enum rejects 480p). Expected: E006 again
// ("Reference images, videos, and audios cannot be used together with first or last frame
// images") — the error text was explicit, but this combo gates the frame-first architecture.

import Replicate from 'replicate';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { r2, R2_BUCKET } from '../storage/r2';

const STILL_KEY = 'generations/smoke-vlog/still-0-1784991770124.png'; // arm-B take 0 still
const AUDIO_KEY = 'assets/characters/gorilla/voice-smoke-harvard.wav';

async function presign(key: string): Promise<string> {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 3600 });
}

async function main(): Promise<void> {
  const replicate = new Replicate({ auth: config.replicateApiToken });
  const image = await presign(STILL_KEY);
  const audio = await presign(AUDIO_KEY);

  for (const resolution of ['480p', '720p']) {
    console.log(`\n--- attempt: image + reference_audios, 4s, ${resolution} ---`);
    try {
      const output = await replicate.run('bytedance/seedance-2.0-mini', {
        input: {
          prompt: 'A gorilla vlogger says: "Testing one two three."',
          image,
          reference_audios: [audio],
          duration: 4,
          resolution,
          aspect_ratio: '9:16',
          generate_audio: true,
        },
      });
      console.log('ACCEPTED — combo works at', resolution, '→', output);
      return; // no point trying the next resolution
    } catch (error) {
      console.log(`REJECTED at ${resolution}:`, error instanceof Error ? error.message : error);
    }
  }
}

main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
