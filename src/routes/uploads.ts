// src/routes/uploads.ts
// POST /api/uploads — accepts multipart/form-data with single file, validates MIME type,
// stores to R2 under uploads/{userId}/{uuid}.{ext}, persists record to reference_uploads,
// returns presigned URL (1-hour TTL). SECURITY: MIME whitelist via multer fileFilter. 50MB limit.
// GET /api/uploads — lists user's uploaded reference media with fresh presigned URLs.
// POST /api/uploads/from-generation — promotes a completed generation's output into the
// permanent reference library (copies the R2 object so the reference is independently owned).
// DELETE /api/uploads/:id — deletes upload from R2 and DB; IDOR-guarded by user ownership.
// CLAUDE.md Rule 2: raw r2_key never returned — always presigned URL.

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2, R2_BUCKET } from '../storage/r2';
import { db } from '../db/client';
import { referenceUploads, generations } from '../db/schema';
import { eq, desc, and, sql } from 'drizzle-orm';

export const uploadsRouter = Router();

const ALLOWED_KINDS = new Set(['reference', 'look']);

const ALLOWED_MIMES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
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
  const kind = typeof req.body?.kind === 'string' && req.body.kind.length > 0 ? req.body.kind : 'reference';
  if (!ALLOWED_KINDS.has(kind)) {
    res.status(400).json({ error: "kind must be 'reference' or 'look'" });
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

    // D-14 singleton: kind='look' replaces any prior look for this user (Pitfall 6 — avoid
    // orphaned R2 objects by deleting the prior row + object before inserting the new one).
    if (kind === 'look') {
      const priorLooks = await db
        .select({ id: referenceUploads.id, r2_key: referenceUploads.r2_key })
        .from(referenceUploads)
        .where(and(eq(referenceUploads.user_id, req.user.dbUserId), eq(referenceUploads.kind, 'look')))
        .limit(5);

      for (const prior of priorLooks) {
        try {
          await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: prior.r2_key }));
        } catch (err) {
          console.error('[uploads] Best-effort delete of prior look R2 object failed:', err);
        }
      }
      if (priorLooks.length > 0) {
        await db
          .delete(referenceUploads)
          .where(and(eq(referenceUploads.user_id, req.user.dbUserId), eq(referenceUploads.kind, 'look')));
      }
    }

    // Persist upload record so the user can reference it later via GET /api/uploads
    const [insertedRow] = await db.insert(referenceUploads).values({
      user_id: req.user.dbUserId,
      r2_key: key,
      mime_type: req.file.mimetype,
      kind,
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
  const kindFilter = typeof req.query.kind === 'string' ? req.query.kind : undefined;
  if (kindFilter !== undefined && !ALLOWED_KINDS.has(kindFilter)) {
    res.status(400).json({ error: "kind must be 'reference' or 'look'" });
    return;
  }
  try {
    const whereClause = kindFilter
      ? and(eq(referenceUploads.user_id, req.user.dbUserId), eq(referenceUploads.kind, kindFilter))
      : eq(referenceUploads.user_id, req.user.dbUserId);

    const rows = await db
      .select()
      .from(referenceUploads)
      .where(whereClause)
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
          kind: row.kind,
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

// POST /api/uploads/from-generation — promote a completed generation's output into the
// permanent reference library. Copies the R2 object under uploads/{userId}/{uuid}.{ext} so
// the new reference_uploads row is independently owned: deleting it (or the original
// generation) never affects the other's media.
uploadsRouter.post('/from-generation', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const { generation_id, display_name } = req.body ?? {};
  if (typeof generation_id !== 'string') {
    res.status(400).json({ error: 'generation_id is required' });
    return;
  }
  try {
    const [gen] = await db
      .select({ r2_key: generations.r2_key, status: generations.status })
      .from(generations)
      .where(and(eq(generations.id, generation_id), eq(generations.user_id, req.user.dbUserId)));
    if (!gen || gen.status !== 'completed' || !gen.r2_key) {
      res.status(404).json({ error: 'Generation not found or not completed' });
      return;
    }

    const ext = gen.r2_key.split('.').pop() ?? 'mp4';
    const mimeType = EXT_TO_MIME[ext] ?? 'video/mp4';
    const key = `uploads/${req.user.dbUserId}/${randomUUID()}.${ext}`;

    await r2.send(
      new CopyObjectCommand({
        Bucket: R2_BUCKET,
        CopySource: `${R2_BUCKET}/${gen.r2_key}`,
        Key: key,
        ContentType: mimeType,
      }),
    );

    const trimmed = typeof display_name === 'string'
      ? display_name.replace(/[\[\]]/g, '').trim().slice(0, 40)
      : '';
    const [insertedRow] = await db
      .insert(referenceUploads)
      .values({
        user_id: req.user.dbUserId,
        r2_key: key,
        mime_type: mimeType,
        display_name: trimmed.length > 0 ? trimmed : null,
      })
      .returning({ id: referenceUploads.id, display_name: referenceUploads.display_name });

    const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 3600 });

    res.status(200).json({
      id: insertedRow?.id ?? null,
      url,
      mime_type: mimeType,
      display_name: insertedRow?.display_name ?? null,
    });
  } catch (err) {
    console.error('[uploads] Error creating reference from generation:', err);
    res.status(500).json({ error: 'Failed to save reference' });
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
