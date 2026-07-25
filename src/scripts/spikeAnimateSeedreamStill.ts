// Spike: ANIMATE CHECK (2026-07-25) — does Mini accept a SEEDREAM-4.5 still as
// reference_images[0] and film it cleanly? The last unknown in the one-shot v1 pipeline
// (seedream still → Mini film). One 5s clip, ~$0.25.
//
//   npx tsx src/scripts/spikeAnimateSeedreamStill.ts
//
// Arm-C path: still as reference_images[0] (NOT firstFrameImage — keeps the door open for the
// qwen voice pin later; E006 bans reference inputs with first/last-frame images).
// No referenceAudios here — voice clone is the separate optional add; Mini rolls its own voice
// from the quoted line.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2, R2_BUCKET } from '../storage/r2';
import { uploadBufferToR2 } from '../services/archivalService';
import { runVlogTake } from '../services/providers/ReplicateProvider';
import { SERVER_CHARACTERS } from '../config/characters';

const STILL_LOCAL = `${process.env.HOME}/Downloads/spike-stills/airport__seedream-2k.png`;
const STILL_KEY = 'spikes/animate-check/airport-seedream.png';
const CLIP_KEY = 'spikes/animate-check/airport-seedream-animate.mp4';
const CLIP_LOCAL = `${process.env.HOME}/Downloads/spike-stills/airport__seedream-animate.mp4`;

async function presign(key: string): Promise<string> {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 7200 });
}

async function main(): Promise<void> {
  const gorilla = SERVER_CHARACTERS.find((c) => c.character_id === 'gorilla');
  if (!gorilla?.vlog) throw new Error('gorilla vlog block missing');

  console.log('uploading seedream still to R2…');
  await uploadBufferToR2(readFileSync(STILL_LOCAL), STILL_KEY, 'image/png');
  const stillUrl = await presign(STILL_KEY);

  const prompt =
    `${gorilla.vlog.vlog_framing_prefix}\n\n` +
    'The gorilla vlogger rants to the camera at a crowded airport gate, animated and exasperated, ' +
    'gesturing at the departures board behind him. He says: "They delayed my flight THREE hours. ' +
    'The food cart guy knows my name now."';

  console.log('filming 5s Mini take from seedream still…');
  const started = Date.now();
  const clipKey = await runVlogTake(
    { prompt, durationSeconds: 5, referenceImages: [stillUrl] },
    CLIP_KEY,
  );
  console.log(`filmed in ${((Date.now() - started) / 1000).toFixed(0)}s → r2 ${clipKey}`);

  execSync(`curl -sL "${await presign(clipKey)}" -o "${CLIP_LOCAL}"`);
  console.log(`downloaded → ${CLIP_LOCAL}`);
}

main().catch((err) => {
  console.error('animate check FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
