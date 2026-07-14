// src/scripts/uploadPresetMusic.ts
// Run directly: npm run upload:preset-music
//
// One-off (re-runnable) ingestion script for Phase 13's bundled preset background-music tracks
// (Edit Studio Audio track "preset music" option). Downloads each track fresh from its
// royalty-free source URL (see assets/audio/README.md for the source list + license),
// transcodes to AAC/.m4a via ffmpeg, and PutObjectCommands it to the main (private) R2 bucket
// under `preset-music/{id}.m4a` — the SAME bucket/client the ffmpeg compose worker already
// downloads clip/audio assets from (src/storage/r2.ts's `r2`/`R2_BUCKET`), NOT the separate
// public-assets bucket used by uploadPresetArt.ts for marketing loops/posters. These tracks are
// never served directly to the client by public URL; they are only ever read server-side by the
// ffmpeg worker via the existing downloadR2KeyToFile pattern (ffmpegProcessor.ts).
//
// Source of truth for which tracks/ids exist is src/config/presetMusic.ts's PRESET_MUSIC array —
// this script re-derives its download list from a local TRACK_SOURCES map keyed by the same ids,
// so adding a new track means updating both this map and presetMusic.ts.

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../storage/r2';
import { PRESET_MUSIC } from '../config/presetMusic';

// Keyed by PresetMusicTrack.id — the royalty-free source URL each track is downloaded from.
// All four are Kevin MacLeod (incompetech.com) tracks, CC BY 4.0 — see assets/audio/README.md.
const TRACK_SOURCES: Record<string, string> = {
  'upbeat-corporate': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Wallpaper.mp3',
  carefree: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3',
  'sneaky-snitch': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Sneaky%20Snitch.mp3',
  'cheery-monday': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Cheery%20Monday.mp3',
};

function downloadFile(url: string, destPath: string): void {
  execFileSync('curl', ['-sL', '-o', destPath, url], { stdio: 'inherit' });
}

function transcodeToM4a(inputPath: string, outputPath: string): void {
  execFileSync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-c:a', 'aac',
    '-b:a', '128k',
    outputPath,
  ], { stdio: 'ignore' });
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'preset-music-'));

  try {
    for (const track of PRESET_MUSIC) {
      const sourceUrl = TRACK_SOURCES[track.id];
      if (!sourceUrl) {
        console.warn(`[upload:preset-music] No TRACK_SOURCES entry for "${track.id}" — skipping`);
        continue;
      }

      console.log(`[upload:preset-music] "${track.id}" — downloading from ${sourceUrl}`);
      const rawPath = join(workDir, `${track.id}-src`);
      downloadFile(sourceUrl, rawPath);

      console.log(`[upload:preset-music] "${track.id}" — transcoding to AAC/.m4a`);
      const m4aPath = join(workDir, `${track.id}.m4a`);
      transcodeToM4a(rawPath, m4aPath);

      console.log(`[upload:preset-music] "${track.id}" — uploading to ${R2_BUCKET}/${track.r2Key}`);
      const body = readFileSync(m4aPath);
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: track.r2Key,
        Body: body,
        ContentType: 'audio/mp4',
      }));

      console.log(`[upload:preset-music] "${track.id}" — done (${track.r2Key})`);
    }

    console.log('\n[upload:preset-music] All tracks uploaded.');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[upload:preset-music] Fatal error:', err);
  process.exit(1);
});
