// src/routes/uploads.ts
// POST /api/uploads — accepts multipart/form-data with single file, validates MIME type,
// stores to R2 under uploads/{userId}/{uuid}.{ext}, returns presigned URL (1-hour TTL).
// SECURITY: MIME whitelist via multer fileFilter (T-07-03-01). 50MB limit (T-07-03-02).
// CLAUDE.md Rule 2: raw r2_key never returned — always presigned URL.

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2, R2_BUCKET } from '../storage/r2';

export const uploadsRouter = Router();

const ALLOWED_MIMES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max (D-33)
  fileFilter: (_req, file, cb) => {
    // T-07-03-01: whitelist MIME types; multer rejects unknown types with no file on req
    cb(null, file.mimetype in ALLOWED_MIMES);
  },
});

uploadsRouter.post('/', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'No file provided or unsupported file type' });
    return;
  }
  try {
    const ext = ALLOWED_MIMES[req.file.mimetype];
    const key = `uploads/${req.user.dbUserId}/${uuidv4()}.${ext}`;
    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }),
    );
    // D-34: 1-hour TTL for upload references (CLAUDE.md Rule 2: never expose raw key)
    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
      { expiresIn: 3600 },
    );
    res.status(200).json({ url });
  } catch (err) {
    console.error('[uploads] Error storing file:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});
