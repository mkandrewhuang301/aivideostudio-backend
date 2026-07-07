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
// loop.mp4 is transcoded to the card-art contract (~1080x1920 ceiling — see transcodeLoop below
// for why this isn't 480x640 anymore, H.264 baseline, no audio) and a poster.jpg is extracted
// from the first frame if one wasn't supplied. When ffmpeg is not installed, files are uploaded
// as-is — the operator is expected to deliver pre-encoded assets.
//
// Also scans backend/assets/preset-art/<preset_id>/styles/<style_id>.{jpg,jpeg,png} — one still
// photo per style_grid option (2026-07-07 notes/hairstyle-preset-style-images-gender-filter.md).
// Each becomes both the PresetInputSheet grid thumbnail AND the second reference image sent to
// the model alongside the user's own photo (see presetResolver.ts). Independent of loop.mp4 —
// a preset can have style photos uploaded before/without its tile art existing yet.

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config } from '../config';

const ASSETS_DIR = join(__dirname, '..', '..', 'assets', 'preset-art');

// Preset art is public marketing content and must live in its own public bucket, with its own
// scoped credentials — never the main r2 client/R2_BUCKET, which holds presigned-only user
// generation/upload content (2026-07-07 incident: enabling r2.dev on the shared bucket exposed
// user content bucket-wide).
const PUBLIC_ASSETS_BUCKET = (() => {
  if (!config.r2PublicAssetsBucketName) {
    throw new Error('R2_PUBLIC_ASSETS_BUCKET_NAME is required to upload preset art');
  }
  return config.r2PublicAssetsBucketName;
})();

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.r2PublicAssetsAccessKeyId,
    secretAccessKey: config.r2PublicAssetsSecretAccessKey,
  },
});

function ffmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Loop contract per RESEARCH.md Pattern 6: no audio, H.264, short duration. Bounding box raised
// from the original ~480x640 to 1080x1920 (2026-07-08) — grid tiles crop+zoom into these loops
// (PresetTileView's head-focused framing crop, ~1.65x on top of the base cover-fill), and 480x640
// source pixels stretched under that combined zoom produced visible upscale blur (user-reported).
// 1080x1920 is a "vertical HD" ceiling: portrait sources at or below it pass through at native
// resolution (ffmpeg's min(w,iw)/min(h,ih) only ever scales DOWN, never up), so this only affects
// sources actually larger than 1080x1920, avoiding pointless upscale/file-bloat on tiny sources.
function transcodeLoop(inputPath: string, outputPath: string): void {
  execFileSync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-an', // strip audio track
    '-vf', "scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease",
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
// unlike presigned URLs which rotate on every fetch. `prefix` scopes the version scan — e.g.
// `presets/hairstyle/` for tile art, or `presets/hairstyle/styles/bob-` for one style's photo,
// so each style's version counter is independent of the others and of the tile art.
async function nextVersion(prefix: string): Promise<number> {
  const result = await r2.send(new ListObjectsV2Command({ Bucket: PUBLIC_ASSETS_BUCKET, Prefix: prefix }));
  const keys = (result.Contents ?? []).map((obj) => obj.Key ?? '');
  let maxVersion = 0;
  for (const key of keys) {
    const match = key.match(/-v(\d+)\.(jpg|jpeg|png|mp4)$/);
    if (match) {
      maxVersion = Math.max(maxVersion, parseInt(match[1], 10));
    }
  }
  return maxVersion + 1;
}

function publicUrl(key: string): string {
  if (!config.r2PublicAssetsDomain) {
    throw new Error('R2_PUBLIC_ASSETS_DOMAIN is required to produce a public preset-art URL');
  }
  const domain = config.r2PublicAssetsDomain.replace(/\/$/, '');
  return `${domain}/${key}`;
}

async function uploadFile(localPath: string, key: string, contentType: string): Promise<string> {
  const body = readFileSync(localPath);
  await r2.send(new PutObjectCommand({
    Bucket: PUBLIC_ASSETS_BUCKET,
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

  const version = await nextVersion(`presets/${presetId}/`);
  const posterKey = `presets/${presetId}/poster-v${version}.jpg`;
  const loopKey = `presets/${presetId}/loop-v${version}.mp4`;

  const posterUrl = await uploadFile(finalPosterPath, posterKey, 'image/jpeg');
  const loopUrl = await uploadFile(finalLoopPath, loopKey, 'video/mp4');

  return { posterUrl, loopUrl };
}

const IMAGE_EXT_CONTENT_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

// Downscale style photos the same way loop art is normalized — avoids uploading multi-MB
// phone-camera-resolution stills that a small grid thumbnail / model reference never needs.
function resizeStylePhoto(inputPath: string, outputPath: string): void {
  execFileSync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-vf', "scale='min(1024,iw)':'-2'",
    '-q:v', '3',
    outputPath,
  ], { stdio: 'ignore' });
}

async function processStylePhotos(presetId: string, folder: string, hasFfmpeg: boolean): Promise<Record<string, string>> {
  const stylesDir = join(folder, 'styles');
  if (!existsSync(stylesDir)) return {};

  const files = readdirSync(stylesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => Object.keys(IMAGE_EXT_CONTENT_TYPE).some((ext) => name.toLowerCase().endsWith(ext)));

  const results: Record<string, string> = {};

  for (const filename of files) {
    const ext = Object.keys(IMAGE_EXT_CONTENT_TYPE).find((e) => filename.toLowerCase().endsWith(e))!;
    const styleId = filename.slice(0, -ext.length);
    const inputPath = join(stylesDir, filename);

    let finalPath = inputPath;
    const workDir = join(tmpdir(), `preset-art-${presetId}-style-${styleId}-${Date.now()}`);
    if (hasFfmpeg) {
      mkdirSync(workDir, { recursive: true });
      const resized = join(workDir, `resized${ext}`);
      try {
        resizeStylePhoto(inputPath, resized);
        finalPath = resized;
      } catch (err) {
        console.warn(`[upload:preset-art] "${presetId}" style "${styleId}" — resize failed, uploading as-is:`, (err as Error).message);
      }
    }

    const prefix = `presets/${presetId}/styles/${styleId}-`;
    const version = await nextVersion(prefix);
    const key = `${prefix}v${version}${ext}`;
    results[styleId] = await uploadFile(finalPath, key, IMAGE_EXT_CONTENT_TYPE[ext]);
    console.log(`[upload:preset-art] "${presetId}" — uploaded style "${styleId}"`);
  }

  return results;
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
  const styleResults: Record<string, Record<string, string>> = {};

  for (const presetId of entries) {
    const folder = join(ASSETS_DIR, presetId);
    if (!statSync(folder).isDirectory()) continue;

    const result = await processPreset(presetId, folder, hasFfmpeg);
    if (result) {
      results[presetId] = result;
    }

    const stylePhotos = await processStylePhotos(presetId, folder, hasFfmpeg);
    if (Object.keys(stylePhotos).length > 0) {
      styleResults[presetId] = stylePhotos;
    }
  }

  const uploadedIds = Object.keys(results);
  const styledPresetIds = Object.keys(styleResults);
  if (uploadedIds.length === 0 && styledPresetIds.length === 0) {
    console.log('[upload:preset-art] No presets were uploaded.');
    return;
  }

  if (uploadedIds.length > 0) {
    console.log('\n[upload:preset-art] Done. Paste these into src/config/presets.ts tile fields:\n');
    for (const presetId of uploadedIds) {
      const { posterUrl, loopUrl } = results[presetId];
      console.log(`  ${presetId}:`);
      console.log(`    poster_url: '${posterUrl}',`);
      console.log(`    loop_url: '${loopUrl}',`);
    }
    console.log('');
  }

  if (styledPresetIds.length > 0) {
    console.log('[upload:preset-art] Style photos uploaded — paste each thumb_url into its style_grid entry:\n');
    for (const presetId of styledPresetIds) {
      console.log(`  ${presetId}:`);
      for (const [styleId, url] of Object.entries(styleResults[presetId])) {
        console.log(`    ${styleId} -> thumb_url: '${url}',`);
      }
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error('[upload:preset-art] Fatal error:', err);
  process.exit(1);
});
