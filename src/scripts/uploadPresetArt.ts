// src/scripts/uploadPresetArt.ts
// Run directly: npm run upload:preset-art
//
// "User drops files, they appear" art ingestion path (09.1-CONTEXT.md D-09, RESEARCH.md
// Pattern 6). Scans backend/assets/preset-art/<preset_id>/{poster.jpg,loop.mp4}, uploads each
// to a version-suffixed R2 key (stable URL + free cache-busting, avoids the presigned-URL
// rotation landmine documented in RESEARCH.md), and prints the resulting URLs for pasting into
// src/config/presets.ts.
//
// ffmpeg is optional (RESEARCH.md Environment table: "Missing with fallback"). When available,
// loop.mp4 is transcoded to the card-art contract (~480x640, H.264 baseline, no audio) and a
// poster.jpg is extracted from the first frame if one wasn't supplied. When ffmpeg is not
// installed, files are uploaded as-is — the operator is expected to deliver pre-encoded assets.

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../storage/r2';
import { config } from '../config';

const ASSETS_DIR = join(__dirname, '..', '..', 'assets', 'preset-art');

function ffmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Loop contract per RESEARCH.md Pattern 6: low-res, no audio, ~480x640, H.264, short duration.
function transcodeLoop(inputPath: string, outputPath: string): void {
  execFileSync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-an', // strip audio track
    '-vf', "scale='min(480,iw)':'min(640,ih)':force_original_aspect_ratio=decrease",
    '-c:v', 'libx264',
    '-profile:v', 'baseline',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ], { stdio: 'ignore' });
}

function extractPosterFrame(inputPath: string, outputPath: string): void {
  execFileSync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-vframes', '1',
    '-q:v', '2',
    outputPath,
  ], { stdio: 'ignore' });
}

// Stable, version-suffixed keys (D-09 / T-09.1-10): cache-bust without breaking loop caching,
// unlike presigned URLs which rotate on every fetch.
async function nextVersion(presetId: string): Promise<number> {
  const prefix = `presets/${presetId}/`;
  const result = await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix }));
  const keys = (result.Contents ?? []).map((obj) => obj.Key ?? '');
  let maxVersion = 0;
  for (const key of keys) {
    const match = key.match(/-v(\d+)\.(jpg|mp4)$/);
    if (match) {
      maxVersion = Math.max(maxVersion, parseInt(match[1], 10));
    }
  }
  return maxVersion + 1;
}

function publicUrl(key: string): string {
  if (config.r2PublicDomain) {
    const domain = config.r2PublicDomain.replace(/\/$/, '');
    return `${domain}/${key}`;
  }
  return `https://${config.r2AccountId}.r2.cloudflarestorage.com/${R2_BUCKET}/${key}`;
}

async function uploadFile(localPath: string, key: string, contentType: string): Promise<string> {
  const body = readFileSync(localPath);
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return publicUrl(key);
}

async function processPreset(presetId: string, folder: string, hasFfmpeg: boolean): Promise<{ posterUrl: string; loopUrl: string } | null> {
  const loopPath = join(folder, 'loop.mp4');
  const posterPathInput = join(folder, 'poster.jpg');

  if (!existsSync(loopPath)) {
    console.warn(`[upload:preset-art] Skipping "${presetId}" — no loop.mp4 found in ${folder}`);
    return null;
  }

  const workDir = join(tmpdir(), `preset-art-${presetId}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  let finalLoopPath = loopPath;
  let finalPosterPath = posterPathInput;

  if (hasFfmpeg) {
    const transcodedLoop = join(workDir, 'loop.mp4');
    try {
      transcodeLoop(loopPath, transcodedLoop);
      finalLoopPath = transcodedLoop;
      console.log(`[upload:preset-art] "${presetId}" — transcoded loop.mp4 to card-art contract`);
    } catch (err) {
      console.warn(`[upload:preset-art] "${presetId}" — ffmpeg transcode failed, uploading loop.mp4 as-is:`, (err as Error).message);
    }

    if (!existsSync(posterPathInput)) {
      const extractedPoster = join(workDir, 'poster.jpg');
      try {
        extractPosterFrame(finalLoopPath, extractedPoster);
        finalPosterPath = extractedPoster;
        console.log(`[upload:preset-art] "${presetId}" — extracted poster.jpg from first frame`);
      } catch (err) {
        console.error(`[upload:preset-art] "${presetId}" — no poster.jpg supplied and frame extraction failed, skipping:`, (err as Error).message);
        return null;
      }
    }
  } else {
    // ffmpeg NOT installed (RESEARCH.md Environment table fallback): accept pre-encoded files
    // as-is. Poster is required in this path since we cannot extract a frame without ffmpeg.
    if (!existsSync(posterPathInput)) {
      console.error(`[upload:preset-art] "${presetId}" — ffmpeg not available and no poster.jpg supplied; skipping (deliver a pre-encoded poster.jpg alongside loop.mp4)`);
      return null;
    }
    console.log(`[upload:preset-art] "${presetId}" — ffmpeg not found, uploading pre-encoded files as-is`);
  }

  const version = await nextVersion(presetId);
  const posterKey = `presets/${presetId}/poster-v${version}.jpg`;
  const loopKey = `presets/${presetId}/loop-v${version}.mp4`;

  const posterUrl = await uploadFile(finalPosterPath, posterKey, 'image/jpeg');
  const loopUrl = await uploadFile(finalLoopPath, loopKey, 'video/mp4');

  return { posterUrl, loopUrl };
}

async function main() {
  if (!existsSync(ASSETS_DIR)) {
    console.error(`[upload:preset-art] No assets directory found at ${ASSETS_DIR}`);
    console.error('[upload:preset-art] Create backend/assets/preset-art/<preset_id>/{poster.jpg,loop.mp4} and re-run.');
    process.exit(1);
  }

  const hasFfmpeg = ffmpegAvailable();
  console.log(`[upload:preset-art] ffmpeg available: ${hasFfmpeg}`);
  console.log(`[upload:preset-art] Scanning ${ASSETS_DIR} ...`);

  const entries = readdirSync(ASSETS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (entries.length === 0) {
    console.log('[upload:preset-art] No preset folders found. Nothing to upload.');
    return;
  }

  const results: Record<string, { posterUrl: string; loopUrl: string }> = {};

  for (const presetId of entries) {
    const folder = join(ASSETS_DIR, presetId);
    if (!statSync(folder).isDirectory()) continue;

    const result = await processPreset(presetId, folder, hasFfmpeg);
    if (result) {
      results[presetId] = result;
    }
  }

  const uploadedIds = Object.keys(results);
  if (uploadedIds.length === 0) {
    console.log('[upload:preset-art] No presets were uploaded.');
    return;
  }

  console.log('\n[upload:preset-art] Done. Paste these into src/config/presets.ts tile fields:\n');
  for (const presetId of uploadedIds) {
    const { posterUrl, loopUrl } = results[presetId];
    console.log(`  ${presetId}:`);
    console.log(`    poster_url: '${posterUrl}',`);
    console.log(`    loop_url: '${loopUrl}',`);
  }
  console.log('');
}

main().catch((err) => {
  console.error('[upload:preset-art] Fatal error:', err);
  process.exit(1);
});
