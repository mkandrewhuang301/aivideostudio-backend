// src/scripts/smokeCelebrity.ts
// One-off smoke test for the AWS Rekognition celebrity-likeness check.
// Run: npx tsx src/scripts/smokeCelebrity.ts
// Verifies the AWS creds work and RecognizeCelebrities returns a match on a known public figure,
// and passes a non-celebrity image through. Does NOT boot the server or touch the DB.

import 'dotenv/config';
import sharp from 'sharp';
import { RekognitionClient, RecognizeCelebritiesCommand } from '@aws-sdk/client-rekognition';
import { checkCelebrity, fitForRekognition } from '../services/celebrityService';
import { config } from '../config';

function rekClient() {
  return new RekognitionClient({
    region: config.awsRegion,
    credentials: config.awsAccessKeyId && config.awsSecretAccessKey
      ? { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey }
      : undefined,
  });
}

// Prove the downscale path: blow a celebrity photo up past 5 MB, run it through fitForRekognition,
// and confirm the shrunk copy is under the limit AND still matches a celebrity.
async function testDownscale(): Promise<void> {
  const resp = await fetch(CELEBRITY_IMAGE);
  const original = new Uint8Array(await resp.arrayBuffer());
  // Upscale + max quality to force it over the 5 MB inline limit, simulating a big phone photo.
  const big = new Uint8Array(
    await sharp(Buffer.from(original)).resize({ width: 5000 }).jpeg({ quality: 100 }).toBuffer(),
  );
  console.log(`  inflated to ${(big.byteLength / 1024 / 1024).toFixed(1)}MB (over 5MB limit)`);

  const fitted = await fitForRekognition(big);
  console.log(`  fitForRekognition → ${(fitted.byteLength / 1024 / 1024).toFixed(2)}MB (must be < 5MB)`);

  const result = await rekClient().send(new RecognizeCelebritiesCommand({ Image: { Bytes: fitted } }));
  const names = (result.CelebrityFaces ?? []).map((c) => `${c.Name} (${c.MatchConfidence?.toFixed(1)}%)`);
  console.log('  downscaled copy still recognizes →', names.length ? names.join(', ') : '(no match — PROBLEM)');
}

// Raw probe — unlike checkCelebrity (which fails OPEN), this lets AWS errors THROW so an
// AccessDenied / bad-creds problem is unmistakable instead of masquerading as "no match".
async function rawProbe(imageUrl: string): Promise<void> {
  const client = new RekognitionClient({
    region: config.awsRegion,
    credentials: config.awsAccessKeyId && config.awsSecretAccessKey
      ? { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey }
      : undefined,
  });
  const resp = await fetch(imageUrl);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const result = await client.send(new RecognizeCelebritiesCommand({ Image: { Bytes: bytes } }));
  const names = (result.CelebrityFaces ?? []).map((c) => `${c.Name} (${c.MatchConfidence?.toFixed(1)}%)`);
  console.log('  raw RecognizeCelebrities →', names.length ? names.join(', ') : '(no celebrity faces)');
}

// Public-domain official portrait (Wikimedia) — Rekognition recognizes this with high confidence.
const CELEBRITY_IMAGE = 'https://upload.wikimedia.org/wikipedia/commons/8/8d/President_Barack_Obama.jpg';
// A generic, non-celebrity stock face — should NOT match.
const NON_CELEBRITY_IMAGE = 'https://upload.wikimedia.org/wikipedia/commons/7/7e/Dalai_Lama_%28cropped%29.jpg';

async function main() {
  console.log('[smoke] celebrityCheckEnabled =', config.celebrityCheckEnabled);
  console.log('[smoke] region =', config.awsRegion, '| threshold =', config.celebrityMatchThreshold);
  console.log('[smoke] AWS key present =', config.awsAccessKeyId ? 'yes' : 'NO — missing');

  console.log('\n[smoke] Raw probe (surfaces auth errors — expect Barack Obama)...');
  try {
    await rawProbe(CELEBRITY_IMAGE);
  } catch (e) {
    console.error('  ❌ Raw probe threw — likely a creds/permission problem:', e instanceof Error ? e.name + ': ' + e.message : e);
  }

  console.log('\n[smoke] Checking a known public figure via checkCelebrity (expect MATCH)...');
  const celeb = await checkCelebrity(CELEBRITY_IMAGE);
  console.log('  →', JSON.stringify(celeb));

  console.log('\n[smoke] Downscale path — big (>5MB) image still gets checked...');
  try {
    await testDownscale();
  } catch (e) {
    console.error('  ❌ Downscale test threw:', e instanceof Error ? e.message : e);
  }

  console.log('\n[smoke] Checking a second face (informational)...');
  const other = await checkCelebrity(NON_CELEBRITY_IMAGE);
  console.log('  →', JSON.stringify(other));

  if (celeb.matched) {
    console.log('\n✅ PASS: Rekognition creds work and a celebrity was matched. The block will fire.');
  } else {
    console.log('\n⚠️  No match returned. Either the creds/permission are wrong (check logs above for an');
    console.log('   auth error — celebrityService fails OPEN on error, so a silent {matched:false} can');
    console.log('   mean an AccessDenied), or the image fetch failed. Verify the IAM policy is attached.');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
