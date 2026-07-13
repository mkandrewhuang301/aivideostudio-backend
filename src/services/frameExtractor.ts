// src/services/frameExtractor.ts
// Extracts a single still frame from an uploaded video via ffmpeg — Stage 1 of AI Influencer
// Pro's 3-step pipeline (influencerProWorker.ts): frame extract -> Wan 2.7 composite -> Kling v3
// Motion Control. Deliberately NOT part of ffmpegWorker.ts/ffmpegProcessor.ts — that worker only
// ever runs POST-generation (muxing audio onto an already-archived clip via a BullMQ postprocess
// job keyed on FfmpegJobData); this runs PRE-generation, synchronously, on a user's just-uploaded
// video, mirroring the same synchronous call shape ReplicateProvider.ts's
// generateKeyframeFromPhotos already uses for the chain worker's Wan 2.7 stage.
//
// T-09.3-03 (same pattern as ffmpegProcessor.ts): ffmpeg invoked via execFile with a fixed argv
// array, never a shell string — the only untrusted input here (videoUrl) is never interpolated
// into a shell command.

import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Upload } from '@aws-sdk/lib-storage';
import { r2, R2_BUCKET } from '../storage/r2';

const execFileAsync = promisify(execFile);

/**
 * Downloads `videoUrl`, grabs one frame at `atSeconds` (default 0.5s — not frame 0, which camera
 * apps often pad with a black/settling frame), uploads it to R2 at
 * `generations/${outputKeyArg}.png`, and returns that R2 key.
 */
export async function extractVideoFrame(
  videoUrl: string,
  outputKeyArg: string,
  atSeconds: number = 0.5,
): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'frame-extract-'));
  try {
    const inputPath = path.join(tempDir, 'in.mp4');
    const outputPath = path.join(tempDir, 'frame.png');

    const response = await fetch(videoUrl);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download video for frame extraction: ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      createWriteStream(inputPath),
    );

    // -ss BEFORE -i: fast (keyframe-nearest) seek — exact-frame accuracy isn't needed, this still
    // only feeds Wan 2.7 as a representative background/lighting reference.
    await execFileAsync('ffmpeg', ['-y', '-ss', String(atSeconds), '-i', inputPath, '-frames:v', '1', outputPath]);

    const key = `generations/${outputKeyArg}.png`;
    const upload = new Upload({
      client: r2,
      params: {
        Bucket: R2_BUCKET,
        Key: key,
        Body: createReadStream(outputPath),
        ContentType: 'image/png',
      },
    });
    await upload.done();
    return key;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
