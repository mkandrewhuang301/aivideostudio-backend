// src/storage/r2.ts
import { S3Client } from '@aws-sdk/client-s3';
import { config } from '../config';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
  },
});

export const R2_BUCKET = config.r2BucketName;
