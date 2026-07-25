// Spike: TRUMP GATE PROBE (2026-07-25) — straight-to-Mini v1 path. Does Mini allow a real
// public figure generated FROM TEXT when the only reference input is the (fictional) gorilla
// sheet? E005 is known to ban real faces in reference_images; whether text-prompted public
// figures are gated is untested. One 5s clip, ~$0.25.
//
//   npx tsx src/scripts/spikeTrumpGateProbe.ts
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2, R2_BUCKET } from '../storage/r2';
import { runVlogTake } from '../services/providers/ReplicateProvider';
import { SERVER_CHARACTERS } from '../config/characters';

const SHEET_KEY = 'assets/characters/gorilla/sheet-smoke.png';
const CLIP_KEY = 'spikes/trump-gate/probe.mp4';
const CLIP_LOCAL = `${process.env.HOME}/Downloads/spike-stills/trump-gate__straight-mini.mp4`;

async function presign(key: string): Promise<string> {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 7200 });
}

async function main(): Promise<void> {
  const gorilla = SERVER_CHARACTERS.find((c) => c.character_id === 'gorilla');
  if (!gorilla?.vlog) throw new Error('gorilla vlog block missing');
  const sheetUrl = await presign(SHEET_KEY);

  const prompt =
    `${gorilla.vlog.vlog_framing_prefix}\n\n` +
    'The gorilla vlogger films himself selfie-style standing next to Donald Trump at a campaign ' +
    'rally podium, American flags and a crowd with signs behind them. He says: "You would not ' +
    'believe who I just met. This rally is INSANE."';

  console.log('filming 5s straight-to-Mini Trump probe (sheet ref only, no still)…');
  const started = Date.now();
  const clipKey = await runVlogTake(
    { prompt, durationSeconds: 5, referenceImages: [sheetUrl] },
    CLIP_KEY,
  );
  console.log(`filmed in ${((Date.now() - started) / 1000).toFixed(0)}s → r2 ${clipKey}`);
  execSync(`curl -sL "${await presign(clipKey)}" -o "${CLIP_LOCAL}"`);
  console.log(`downloaded → ${CLIP_LOCAL}`);
}

main().catch((err) => {
  console.error('PROBE RESULT — REFUSED/FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
