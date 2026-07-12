// src/queue/ffmpegProcessor.ts
// Real I/O for the ffmpeg post-process stage (D-06): downloads the job's R2 input(s) into a
// scoped temp dir, shells out to the ffmpeg binary via execFile with a fixed argv array (never a
// shell string — T-09.3-03: untrusted generationId/keys must never allow path traversal or shell
// injection), uploads the resulting MP4 back to R2, and returns the new canonical r2Key.
//
// Split out of ffmpegWorker.ts so that file's BullMQ lifecycle + completion-rejoin logic can be
// unit tested by mocking this module as a single seam, without any live ffmpeg binary, network
// fetch, or R2 credentials in the test process.

import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Upload } from '@aws-sdk/lib-storage';
import { r2, R2_BUCKET } from '../storage/r2';
import { getGenerationPresignedUrl } from '../services/archivalService';
import type { FfmpegJobData } from './ffmpegWorker';

const execFileAsync = promisify(execFile);

async function downloadR2KeyToFile(r2Key: string, destPath: string): Promise<void> {
  const url = await getGenerationPresignedUrl(r2Key);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ffmpeg input ${r2Key}: ${response.status}`);
  }
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    createWriteStream(destPath),
  );
}

async function uploadFileToR2(localPath: string, r2Key: string): Promise<void> {
  const upload = new Upload({
    client: r2,
    params: {
      Bucket: R2_BUCKET,
      Key: r2Key,
      Body: createReadStream(localPath),
      ContentType: 'video/mp4',
    },
  });
  await upload.done();
}

// T-09.3-03: argv array only — never interpolate a raw key/path into a shell string.
async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', args);
}

/**
 * Downloads inputs, runs the mux or concat ffmpeg command, uploads the result to R2, and returns
 * the final r2Key (`generations/${generationId}.mp4`) plus, for mux ops, the preserved silent
 * master key (`generations/${generationId}.silent.mp4`). Always cleans up the temp dir, even on
 * error — the caller (processFfmpegJob) lets BullMQ's retry/final-failure handling take over.
 */
export async function runFfmpegOp(data: FfmpegJobData): Promise<{ r2Key: string; masterR2Key?: string }> {
  const { generationId, inputR2Keys, audioR2Key, op } = data;
  // T-09.3-03: only ever write under os.tmpdir()/ffmpeg-${generationId}-* — scoped to this job.
  const tempDir = await mkdtemp(path.join(tmpdir(), `ffmpeg-${generationId}-`));

  try {
    const outPath = path.join(tempDir, 'out.mp4');

    if (op === 'mux') {
      if (!audioR2Key) throw new Error('ffmpeg mux op requires audioR2Key');
      const clipPath = path.join(tempDir, 'clip.mp4');
      const audioPath = path.join(tempDir, 'audio.m4a');
      await downloadR2KeyToFile(inputR2Keys[0], clipPath);
      // D-04: preserve the pre-mux (silent) clip at a distinct key BEFORE muxing, so the
      // canonical generations/${id}.mp4 key can be safely overwritten by the muxed output below
      // without clobbering the swappable silent source the future editor phase re-muxes from.
      const masterR2Key = `generations/${generationId}.silent.mp4`;
      await uploadFileToR2(clipPath, masterR2Key);
      await downloadR2KeyToFile(audioR2Key, audioPath);
      await runFfmpeg([
        '-y', '-i', clipPath, '-i', audioPath,
        '-map', '0:v', '-map', '1:a', '-shortest',
        '-c:v', 'copy', '-c:a', 'aac', outPath,
      ]);
      const r2Key = `generations/${generationId}.mp4`;
      await uploadFileToR2(outPath, r2Key);
      return { r2Key, masterR2Key };
    } else {
      const clipPaths: string[] = [];
      for (let i = 0; i < inputR2Keys.length; i++) {
        const clipPath = path.join(tempDir, `clip${i}.mp4`);
        await downloadR2KeyToFile(inputR2Keys[i], clipPath);
        clipPaths.push(clipPath);
      }
      const listPath = path.join(tempDir, 'list.txt');
      // Concat-demuxer filelist — entries are always our own tempDir paths written above, never
      // raw R2 keys or user input, so single-quote escaping here is a hygiene measure, not a
      // security boundary (the boundary is that nothing outside tempDir is ever referenced).
      const listContents = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
      await writeFile(listPath, listContents, 'utf-8');
      try {
        await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
      } catch {
        // Codec/resolution mismatch across clips — fall back to a re-encode.
        await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-c:a', 'aac', outPath]);
      }
      const r2Key = `generations/${generationId}.mp4`;
      await uploadFileToR2(outPath, r2Key);
      return { r2Key };
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
