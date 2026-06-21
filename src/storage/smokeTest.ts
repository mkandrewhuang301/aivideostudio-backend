// src/storage/smokeTest.ts
// Run directly: npx tsx src/storage/smokeTest.ts
// Exits 0 if R2 PUT + presigned GET work, exits 1 on failure.

import 'dotenv/config';
import {
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2, R2_BUCKET } from './r2';

const TEST_KEY = `smoke-test/r2-test-${Date.now()}.txt`;
const TEST_BODY = 'fantasia-r2-smoke-test';

async function main() {
  console.log(`[R2] Running smoke test against bucket: ${R2_BUCKET}`);

  // 1. Upload test object
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: TEST_KEY,
    Body: TEST_BODY,
    ContentType: 'text/plain',
  }));
  console.log(`[R2] PUT ${TEST_KEY} — OK`);

  // 2. Generate presigned GET URL (15-minute expiry)
  const presignedUrl = await getSignedUrl(
    r2,
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: TEST_KEY }),
    { expiresIn: 900 },
  );
  console.log(`[R2] Presigned GET URL generated: ${presignedUrl.substring(0, 80)}...`);

  // 3. Fetch via presigned URL to confirm it works
  const fetchResponse = await fetch(presignedUrl);
  if (!fetchResponse.ok) {
    throw new Error(`Presigned GET failed: HTTP ${fetchResponse.status}`);
  }
  const body = await fetchResponse.text();
  if (body !== TEST_BODY) {
    throw new Error(`Content mismatch: expected "${TEST_BODY}", got "${body}"`);
  }
  console.log('[R2] Presigned GET fetch — OK, content matches');

  // 4. Delete test object (cleanup)
  await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: TEST_KEY }));
  console.log(`[R2] DELETE ${TEST_KEY} — OK`);

  console.log('[R2] Smoke test PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('[R2] Smoke test FAILED:', err.message);
  process.exit(1);
});
