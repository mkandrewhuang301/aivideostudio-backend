// src/routes/projects.ts
// Phase 13 (Edit Studio): project hub + editor-state CRUD.
// Every handler starts with the req.user?.dbUserId auth guard, and every query is scoped by
// user_id (directly for project rows, via a project-ownership resolution for child rows) —
// mirrors the IDOR pattern established in uploads.ts/generations.ts (T-13-07).

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../storage/r2';
import { db } from '../db/client';
import { projects, projectClips, generations } from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { getUploadPresignedUrl } from '../services/archivalService';
import {
  createProject,
  listProjects,
  getProjectWithState,
  updateProject,
  deleteProject,
  importClipByCopy,
  smartUnpackOnImport,
  ImportSourceNotFoundError,
  MAX_CLIPS_PER_PROJECT,
} from '../services/projectService';

export const projectsRouter = Router();

const VALID_ASPECT_RATIOS = ['9:16', '4:5', '1:1', '16:9'];
const VALID_CAPTION_POSITIONS = ['top', 'middle', 'bottom'];

const ALLOWED_CLIP_MIMES: Record<string, string> = {
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

const clipUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB — clips can be short video, larger than a still image reference
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype in ALLOWED_CLIP_MIMES);
  },
});

// POST /api/projects — create a new project (D-01/D-02)
projectsRouter.post('/', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const { title, aspectRatio } = req.body ?? {};
  if (aspectRatio !== undefined && !VALID_ASPECT_RATIOS.includes(aspectRatio)) {
    res.status(400).json({ error: 'Invalid aspect_ratio' });
    return;
  }
  try {
    const project = await createProject(req.user.dbUserId, {
      title: typeof title === 'string' ? title : undefined,
      aspectRatio: typeof aspectRatio === 'string' ? aspectRatio : undefined,
    });
    res.status(201).json({ project });
  } catch (err) {
    console.error('[projects] Error creating project:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// GET /api/projects — cursor-paginated project hub list, newest-first (D-06)
projectsRouter.get('/', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const { cursor: cursorStr, limit: limitStr } = req.query;
    let cursor: { createdAt: Date; id: string } | undefined;
    if (typeof cursorStr === 'string') {
      const [createdAtStr, id] = cursorStr.split('__');
      if (createdAtStr && id) cursor = { createdAt: new Date(createdAtStr), id };
    }
    const limit = Math.min(Number(limitStr) || 20, 50);
    const items = await listProjects(req.user.dbUserId, cursor, limit);

    const enriched = await Promise.all(
      items.map(async (p) => {
        const { thumbnail_r2_key, ...rest } = p;
        return {
          ...rest,
          thumbnail_url: thumbnail_r2_key ? await getUploadPresignedUrl(thumbnail_r2_key) : null,
        };
      }),
    );
    const last = enriched[enriched.length - 1];
    const nextCursor =
      enriched.length === limit && last
        ? `${last.created_at instanceof Date ? last.created_at.toISOString() : last.created_at}__${last.id}`
        : null;
    res.status(200).json({ items: enriched, nextCursor });
  } catch (err) {
    console.error('[projects] Error listing projects:', err);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// GET /api/projects/:id — full editable project state (D-01), presigned urls for every clip/audio
projectsRouter.get('/:id', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const state = await getProjectWithState(req.params.id as string, req.user.dbUserId);
    if (!state) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.status(200).json({ project: state });
  } catch (err) {
    console.error('[projects] Error fetching project:', err);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// PATCH /api/projects/:id — rename / change aspect ratio / set caption style
// Used by Plan 11 (title rename, aspect toggle) and Plan 16 (Caption Style sheet).
projectsRouter.patch('/:id', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const { title, aspect_ratio, caption_style } = req.body ?? {};

  if (aspect_ratio !== undefined && !VALID_ASPECT_RATIOS.includes(aspect_ratio)) {
    res.status(400).json({ error: 'Invalid aspect_ratio' });
    return;
  }
  if (
    caption_style !== undefined &&
    caption_style?.position !== undefined &&
    !VALID_CAPTION_POSITIONS.includes(caption_style.position)
  ) {
    res.status(400).json({ error: 'Invalid caption_style.position' });
    return;
  }

  try {
    const updated = await updateProject(req.params.id as string, req.user.dbUserId, {
      title: typeof title === 'string' ? title : undefined,
      aspectRatio: typeof aspect_ratio === 'string' ? aspect_ratio : undefined,
      captionStyle: caption_style !== undefined ? caption_style : undefined,
    });
    if (!updated) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.status(200).json({ project: updated });
  } catch (err) {
    console.error('[projects] Error updating project:', err);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// DELETE /api/projects/:id — reuses the existing swipe/long-press confirm-dialog UI pattern (D-04)
projectsRouter.delete('/:id', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const ok = await deleteProject(req.params.id as string, req.user.dbUserId);
    if (!ok) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    console.error('[projects] Error deleting project:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// POST /api/projects/:id/clips — import a clip by copy (D-03), either from an owned generation
// or a fresh multipart upload. Smart-unpacks structured generations (D-15/D-16) instead of
// importing one opaque clip when the source carries a params.structured marker.
projectsRouter.post('/:id/clips', clipUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const projectId = req.params.id as string;
  try {
    const [ownedProject] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.user_id, req.user.dbUserId)));
    if (!ownedProject) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(projectClips)
      .where(eq(projectClips.project_id, projectId));
    if (Number(count) >= MAX_CLIPS_PER_PROJECT) {
      res.status(400).json({ error: `Project already has the maximum of ${MAX_CLIPS_PER_PROJECT} clips` });
      return;
    }

    if (req.file) {
      // Upload source — write directly to projects/{id}/clips/ (fresh upload, no prior owner; Pattern 4)
      const ext = ALLOWED_CLIP_MIMES[req.file.mimetype];
      const mediaType: 'video' | 'image' = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
      const key = `projects/${projectId}/clips/${randomUUID()}.${ext}`;
      await r2.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
        }),
      );
      const clip = await importClipByCopy({
        projectId,
        userId: req.user.dbUserId,
        sourceType: 'upload',
        uploadedR2Key: key,
        mimeType: req.file.mimetype,
        mediaType,
      });
      res.status(201).json({ clip });
      return;
    }

    const { source_type, generation_id } = req.body ?? {};
    if (source_type !== 'generation' || typeof generation_id !== 'string') {
      res.status(400).json({ error: 'Provide a file upload, or { source_type: "generation", generation_id }' });
      return;
    }

    // Ownership-scoped source resolution (T-13-08) — resolved here (not just inside
    // importClipByCopy) so we have the generation row available for smartUnpackOnImport below.
    const [genRow] = await db
      .select()
      .from(generations)
      .where(and(eq(generations.id, generation_id), eq(generations.user_id, req.user.dbUserId)));
    if (!genRow || genRow.status !== 'completed' || !genRow.r2_key) {
      res.status(404).json({ error: 'Generation not found, not owned, or not completed' });
      return;
    }
    const ext = genRow.r2_key.split('.').pop() ?? 'mp4';
    const mimeType = EXT_TO_MIME[ext] ?? 'video/mp4';
    const mediaType: 'video' | 'image' = genRow.media_type === 'image' ? 'image' : 'video';

    const clip = await importClipByCopy({
      projectId,
      userId: req.user.dbUserId,
      sourceType: 'generation',
      sourceId: generation_id,
      mimeType,
      mediaType,
    });

    const { unpacked } = await smartUnpackOnImport(projectId, { id: genRow.id, params: genRow.params });

    res.status(201).json(unpacked ? { clip, unpacked: true } : { clip });
  } catch (err) {
    if (err instanceof ImportSourceNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error('[projects] Error importing clip:', err);
    res.status(500).json({ error: 'Failed to import clip' });
  }
});

// PATCH /api/projects/:id/clips/:clipId — trim/reorder a clip (SC2)
projectsRouter.patch('/:id/clips/:clipId', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const projectId = req.params.id as string;
  const clipId = req.params.clipId as string;
  const { sort_order, trim_start_seconds, trim_end_seconds } = req.body ?? {};

  try {
    const [ownedProject] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.user_id, req.user.dbUserId)));
    if (!ownedProject) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const setValues: Record<string, unknown> = {};
    if (sort_order !== undefined) {
      if (typeof sort_order !== 'number') {
        res.status(400).json({ error: 'sort_order must be a number' });
        return;
      }
      setValues.sort_order = sort_order;
    }
    if (trim_start_seconds !== undefined) {
      if (typeof trim_start_seconds !== 'number') {
        res.status(400).json({ error: 'trim_start_seconds must be a number' });
        return;
      }
      setValues.trim_start_seconds = trim_start_seconds;
    }
    if (trim_end_seconds !== undefined) {
      if (typeof trim_end_seconds !== 'number') {
        res.status(400).json({ error: 'trim_end_seconds must be a number' });
        return;
      }
      setValues.trim_end_seconds = trim_end_seconds;
    }
    if (Object.keys(setValues).length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    const [clip] = await db
      .update(projectClips)
      .set(setValues)
      .where(and(eq(projectClips.id, clipId), eq(projectClips.project_id, projectId)))
      .returning();
    if (!clip) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }
    res.status(200).json({ clip });
  } catch (err) {
    console.error('[projects] Error updating clip:', err);
    res.status(500).json({ error: 'Failed to update clip' });
  }
});

// DELETE /api/projects/:id/clips/:clipId — remove a clip row + its R2 object
projectsRouter.delete('/:id/clips/:clipId', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const projectId = req.params.id as string;
  const clipId = req.params.clipId as string;
  try {
    const [ownedProject] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.user_id, req.user.dbUserId)));
    if (!ownedProject) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const [clip] = await db
      .select({ r2_key: projectClips.r2_key })
      .from(projectClips)
      .where(and(eq(projectClips.id, clipId), eq(projectClips.project_id, projectId)));
    if (!clip) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: clip.r2_key }));
    await db.delete(projectClips).where(eq(projectClips.id, clipId));
    res.status(204).send();
  } catch (err) {
    console.error('[projects] Error deleting clip:', err);
    res.status(500).json({ error: 'Failed to delete clip' });
  }
});
