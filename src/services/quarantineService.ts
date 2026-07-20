import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../storage/r2';

function encodedCopySource(key: string): string {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${encodeURIComponent(R2_BUCKET)}/${encodedKey}`;
}

/**
 * Move flagged media under the lifecycle-managed quarantine/ prefix.
 * Copy-before-delete is deliberate: a failed copy never destroys the only reportable artifact.
 */
export async function quarantineGenerationMedia(generationId: string, r2Key: string): Promise<string> {
  if (r2Key.startsWith('quarantine/')) return r2Key;

  const fileName = r2Key.split('/').pop() || `${generationId}.bin`;
  const quarantineKey = `quarantine/${generationId}/${fileName}`;
  await r2.send(new CopyObjectCommand({
    Bucket: R2_BUCKET,
    CopySource: encodedCopySource(r2Key),
    Key: quarantineKey,
  }));
  await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }));
  return quarantineKey;
}
