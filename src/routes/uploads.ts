// src/routes/uploads.ts
// POST /api/uploads — accepts multipart/form-data with single file, validates MIME type,
// stores to R2 under uploads/{userId}/{uuid}.{ext}, persists record to reference_uploads,
// returns presigned URL (1-hour TTL). SECURITY: MIME whitelist via multer fileFilter. 50MB limit.
// GET /api/uploads — lists user's uploaded reference media with fresh presigned URLs.
// DELETE /api/uploads/:id — deletes upload from R2 and DB; IDOR-guarded by user ownership.
// CLAUDE.md Rule 2: raw r2_key never returned — always presigned URL.

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2, R2_BUCKET } from '../storage/r2';
import { db } from '../db/client';
import { referenceUploads } from '../db/schema';
import { eq, desc, and, sql } from 'drizzle-orm';

export const uploadsRouter = Router();

const ALLOWED_MIMES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (_req, file, cb) => {
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
    const key = `uploads/${req.user.dbUserId}/${randomUUID()}.${ext}`;

    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }),
    );

    // Persist upload record so the user can reference it later via GET /api/uploads
    const [insertedRow] = await db.insert(referenceUploads).values({
      user_id: req.user.dbUserId,
      r2_key: key,
      mime_type: req.file.mimetype,
    }).returning({ id: referenceUploads.id });

    // 1-hour presigned URL (CLAUDE.md Rule 2: never expose raw key)
    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
      { expiresIn: 3600 },
    );

    res.status(200).json({ id: insertedRow?.id ?? null, url });
  } catch (err) {
    console.error('[uploads] Error storing file:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// GET /api/uploads — returns the authenticated user's uploaded reference media,
// newest first, with fresh presigned URLs generated at query time (R2 objects don't expire).
uploadsRouter.get('/', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const rows = await db
      .select()
      .from(referenceUploads)
      .where(eq(referenceUploads.user_id, req.user.dbUserId))
      .orderBy(desc(referenceUploads.created_at))
      .limit(50);

    const uploads = await Promise.all(
      rows.map(async (row) => {
        const url = await getSignedUrl(
          r2,
          new GetObjectCommand({ Bucket: R2_BUCKET, Key: row.r2_key }),
          { expiresIn: 3600 },
        );
        return {
          id: row.id,
          url,
          mime_type: row.mime_type,
          display_name: row.display_name ?? null,
          created_at: row.created_at,
        };
      }),
    );

    res.status(200).json({ uploads });
  } catch (err) {
    console.error('[uploads] Error listing uploads:', err);
    res.status(500).json({ error: 'Failed to list uploads' });
  }
});

// PATCH /api/uploads/:id — rename an upload (set display_name). Empty string clears it.
// IDOR-guarded: user can only rename their own uploads.
uploadsRouter.patch('/:id', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const id = req.params.id as string;
  const { display_name } = req.body ?? {};
  if (typeof display_name !== 'string') {
    res.status(400).json({ error: 'display_name must be a string' });
    return;
  }
  // Strip bracket chars that would break token syntax; trim; cap at 40 chars
  const trimmed = display_name.replace(/[\[\]]/g, '').trim().slice(0, 40);
  try {
    const [row] = await db
      .select({ id: referenceUploads.id })
      .from(referenceUploads)
      .where(and(eq(referenceUploads.id, id), eq(referenceUploads.user_id, req.user.dbUserId)));
    if (!row) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }
    const resolved = trimmed.length > 0 ? trimmed : null;
    await db
      .update(referenceUploads)
      .set({ display_name: resolved })
      .where(eq(referenceUploads.id, id));
    res.status(200).json({ id, display_name: resolved });
  } catch (err) {
    console.error('[uploads] Error renaming upload:', err);
    res.status(500).json({ error: 'Failed to rename upload' });
  }
});

uploadsRouter.delete('/:id', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const id = req.params.id as string;
  try {
    const [row] = await db
      .select()
      .from(referenceUploads)
      .where(and(eq(referenceUploads.id, id), eq(referenceUploads.user_id, req.user.dbUserId)));
    if (!row) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: row.r2_key }));
    await db.delete(referenceUploads).where(eq(referenceUploads.id, id));
    res.status(204).end();
  } catch (err) {
    console.error('[uploads] Error deleting upload:', err);
    res.status(500).json({ error: 'Failed to delete upload' });
  }
});
