// src/services/archivalService.ts
// CLAUDE.md Rule 2: Replicate output URLs expire — fetch and archive to R2 IMMEDIATELY.
// NEVER store or return the Replicate output URL to any client; only the R2 key.
// Phase 8: contentType param added for image support; defaults to 'video/mp4' for backward compat.

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { r2, R2_BUCKET } from '../storage/r2';

export async function archiveToR2(
  outputUrl: string,
  generationId: string,
  contentType: string = 'video/mp4',
): Promise<string> {
  const response = await fetch(outputUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch Replicate output: ${response.status}`);
  }

  // Derive file extension from content type
  const ext =
    contentType === 'video/mp4' ? 'mp4' :
    contentType === 'image/webp' ? 'webp' :
    contentType === 'image/png'  ? 'png'  :
    'jpg';  // default for image/jpeg and any unknown image type
  const key = `generations/${generationId}.${ext}`;

  // Perf: stream the download straight into the R2 upload instead of buffering the entire
  // file into memory first (Buffer.from(await response.arrayBuffer())) and only then starting
  // the upload — that made every archive pay for two full sequential transfers. Upload (from
  // lib-storage) reads response.body in chunks as they arrive and uploads them concurrently,
  // multipart when large enough, so download and upload overlap and peak memory drops from
  // O(file size) to O(chunk size).
  const upload = new Upload({
    client: r2,
    params: {
      Bucket: R2_BUCKET,
      Key: key,
      Body: Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      ContentType: contentType,
    },
  });
  await upload.done();

  return key;
}

// 09.2-08: Magic Editor's OpenAI mask-edit call can return a base64-encoded PNG instead of a
// fetchable URL (data[0].b64_json) — archiveToR2 is URL-only, so this sibling helper decodes the
// buffer directly and reuses the exact same R2 key convention (generations/{id}.{ext}).
export async function archiveBase64ToR2(
  base64Data: string,
  generationId: string,
  contentType: string = 'image/png',
): Promise<string> {
  const ext =
    contentType === 'image/webp' ? 'webp' :
    contentType === 'image/png'  ? 'png'  :
    'jpg';
  const key = `generations/${generationId}.${ext}`;
  const buffer = Buffer.from(base64Data, 'base64');

  const upload = new Upload({
    client: r2,
    params: {
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    },
  });
  await upload.done();

  return key;
}

// D-34: 24-hour TTL for completed generation output
export async function getGenerationPresignedUrl(r2Key: string): Promise<string> {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }), { expiresIn: 86400 });
}

// D-34: 1-hour TTL for uploaded reference media input
export async function getUploadPresignedUrl(r2Key: string): Promise<string> {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }), { expiresIn: 3600 });
}
