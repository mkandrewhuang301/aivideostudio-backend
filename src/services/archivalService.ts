// src/services/archivalService.ts
// CLAUDE.md Rule 2: Replicate output URLs expire — fetch and archive to R2 IMMEDIATELY.
// NEVER store or return the Replicate output URL to any client; only the R2 key.

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../storage/r2';

export async function archiveToR2(outputUrl: string, generationId: string): Promise<string> {
  const response = await fetch(outputUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch Replicate output: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const key = `generations/${generationId}.mp4`;

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'video/mp4',
    }),
  );

  return key;
}
