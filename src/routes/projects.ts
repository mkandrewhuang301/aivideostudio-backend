// src/routes/projects.ts
// Phase 13 (Edit Studio): project hub + editor-state CRUD.
// Every handler starts with the req.user?.dbUserId auth guard, and every query is scoped by
// user_id (directly for project rows, via a project-ownership resolution for child rows) —
// mirrors the IDOR pattern established in uploads.ts/generations.ts (T-13-07).

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { PutObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../storage/r2';
import { db } from '../db/client';
import {
  projects,
  projectClips,
  projectTextOverlays,
  projectAudioClips,
  projectCaptionCues,
  generations,
} from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { getUploadPresignedUrl } from '../services/archivalService';
import { PRESET_MUSIC } from '../config/presetMusic';
import { ffmpegQueue } from '../queue/ffmpegWorker';
import { createGeneration } from '../services/generationService';
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
  addTextOverlay,
  updateTextOverlay,
  deleteTextOverlay,
  MAX_TEXT_OVERLAYS_PER_PROJECT,
  addAudioClip,
  updateAudioClip,
  deleteAudioClip,
  MAX_AUDIO_CLIPS_PER_PROJECT,
  addCaptionCue,
  updateCaptionCue,
  deleteCaptionCue,
  deleteAllCaptions,
  MAX_CAPTION_CUES_PER_PROJECT,
  MAX_WORDS_PER_CUE,
  buildComposeSnapshot,
  ExportValidationError,
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

const ALLOWED_AUDIO_MIMES: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — audio clips are much smaller than video
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype in ALLOWED_AUDIO_MIMES);
  },
});

// multipart bodies send numeric fields as strings — coerce, tolerating absence/empty string.
function parseOptionalNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface CaptionWordBody {
  text: string;
  start_seconds: number;
  end_seconds: number;
}

// Shared word-array validation for POST/PATCH /:id/captions (SC5).
function validateCaptionWords(words: unknown): { error: string } | null {
  if (!Array.isArray(words)) return { error: 'words must be an array' };
  if (words.length > MAX_WORDS_PER_CUE) {
    return { error: `A caption cue can have at most ${MAX_WORDS_PER_CUE} words` };
  }
  for (const w of words) {
    const word = w as Partial<CaptionWordBody> | null;
    if (
      typeof word !== 'object' ||
      word === null ||
      typeof word.text !== 'string' ||
      typeof word.start_seconds !== 'number' ||
      typeof word.end_seconds !== 'number' ||
      word.start_seconds < 0 ||
      word.start_seconds >= word.end_seconds
    ) {
      return { error: 'Each word requires { text, start_seconds, end_seconds } with start_seconds < end_seconds' };
    }
  }
  return null;
}

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

// POST /api/projects/:id/export — real free export (D-07/D-10/D-12/SC7): snapshots the full
// project state at request time (Pitfall 4), creates a NEW free generation row so the client can
// poll it exactly like any other generation, and enqueues the ffmpeg 'compose' job. The project
// row itself is NEVER updated here — exporting does not lock/consume the project (D-12).
projectsRouter.post('/:id/export', async (req: Request, res: Response) => {
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
    if (Number(count) === 0) {
      res.status(400).json({ error: 'Project has no clips to export' });
      return;
    }

    const spec = await buildComposeSnapshot(projectId, req.user.dbUserId);
    if (!spec) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Free (D-10, costCredits: 0) — no credit deduction for exports. A normal generations row so
    // the client's existing GenerationManager poll loop (GET /api/generations/:id) works unchanged.
    const { id: generationId } = await createGeneration({
      user_id: req.user.dbUserId,
      model: 'edit-studio-compose',
      status: 'processing',
      prompt: null,
      params: { export_of_project_id: projectId },
      cost_credits: 0,
      media_type: 'video',
    });

    await ffmpegQueue.add('compose-job', {
      generationId,
      userId: req.user.dbUserId,
      costCredits: 0,
      op: 'compose',
      mediaType: 'video',
      inputR2Keys: [],
      compose: spec,
    });

    res.status(202).json({ generation_id: generationId });
  } catch (err) {
    if (err instanceof ExportValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[projects] Error exporting project:', err);
    res.status(500).json({ error: 'Failed to export project' });
  }
});

// ─── Text overlays (SC3) ────────────────────────────────────────────────────────
// Bounds validation (T-13-44 — the authoritative server-side backstop the iOS plan's
// threat register T-13-32 relies on): x_norm/y_norm ∈ [0,1], width_norm ∈ [0.5,3],
// 0 <= start_seconds < end_seconds. Applied to any field present, on BOTH POST and PATCH.

// POST /api/projects/:id/text — add a draggable Text overlay
projectsRouter.post('/:id/text', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const projectId = req.params.id as string;
  const { text, x_norm, y_norm, width_norm, start_seconds, end_seconds } = req.body ?? {};

  if (typeof text !== 'string' || text.length === 0) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  if (
    typeof x_norm !== 'number' ||
    x_norm < 0 ||
    x_norm > 1 ||
    typeof y_norm !== 'number' ||
    y_norm < 0 ||
    y_norm > 1
  ) {
    res.status(400).json({ error: 'x_norm/y_norm must be between 0 and 1' });
    return;
  }
  if (width_norm !== undefined && (typeof width_norm !== 'number' || width_norm < 0.5 || width_norm > 3)) {
    res.status(400).json({ error: 'width_norm must be between 0.5 and 3' });
    return;
  }
  if (
    typeof start_seconds !== 'number' ||
    typeof end_seconds !== 'number' ||
    start_seconds < 0 ||
    start_seconds >= end_seconds
  ) {
    res.status(400).json({ error: 'Invalid start_seconds/end_seconds' });
    return;
  }

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
      .from(projectTextOverlays)
      .where(eq(projectTextOverlays.project_id, projectId));
    if (Number(count) >= MAX_TEXT_OVERLAYS_PER_PROJECT) {
      res.status(400).json({ error: `Project already has the maximum of ${MAX_TEXT_OVERLAYS_PER_PROJECT} text overlays` });
      return;
    }

    const overlay = await addTextOverlay(projectId, req.user.dbUserId, {
      text,
      xNorm: x_norm,
      yNorm: y_norm,
      widthNorm: typeof width_norm === 'number' ? width_norm : undefined,
      startSeconds: start_seconds,
      endSeconds: end_seconds,
    });
    if (!overlay) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.status(201).json({ text_overlay: overlay });
  } catch (err) {
    console.error('[projects] Error adding text overlay:', err);
    res.status(500).json({ error: 'Failed to add text overlay' });
  }
});

// PATCH /api/projects/:id/text/:textId — move/retime/resize a Text overlay
projectsRouter.patch('/:id/text/:textId', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const { text, x_norm, y_norm, width_norm, start_seconds, end_seconds } = req.body ?? {};

  if (text !== undefined && typeof text !== 'string') {
    res.status(400).json({ error: 'text must be a string' });
    return;
  }
  if (x_norm !== undefined && (typeof x_norm !== 'number' || x_norm < 0 || x_norm > 1)) {
    res.status(400).json({ error: 'x_norm/y_norm must be between 0 and 1' });
    return;
  }
  if (y_norm !== undefined && (typeof y_norm !== 'number' || y_norm < 0 || y_norm > 1)) {
    res.status(400).json({ error: 'x_norm/y_norm must be between 0 and 1' });
    return;
  }
  if (width_norm !== undefined && (typeof width_norm !== 'number' || width_norm < 0.5 || width_norm > 3)) {
    res.status(400).json({ error: 'width_norm must be between 0.5 and 3' });
    return;
  }
  if (start_seconds !== undefined && end_seconds !== undefined) {
    if (
      typeof start_seconds !== 'number' ||
      typeof end_seconds !== 'number' ||
      start_seconds < 0 ||
      start_seconds >= end_seconds
    ) {
      res.status(400).json({ error: 'Invalid start_seconds/end_seconds' });
      return;
    }
  } else if (start_seconds !== undefined && (typeof start_seconds !== 'number' || start_seconds < 0)) {
    res.status(400).json({ error: 'Invalid start_seconds/end_seconds' });
    return;
  } else if (end_seconds !== undefined && (typeof end_seconds !== 'number' || end_seconds <= 0)) {
    res.status(400).json({ error: 'Invalid start_seconds/end_seconds' });
    return;
  }

  try {
    const overlay = await updateTextOverlay(req.params.id as string, req.user.dbUserId, req.params.textId as string, {
      text: typeof text === 'string' ? text : undefined,
      xNorm: typeof x_norm === 'number' ? x_norm : undefined,
      yNorm: typeof y_norm === 'number' ? y_norm : undefined,
      widthNorm: typeof width_norm === 'number' ? width_norm : undefined,
      startSeconds: typeof start_seconds === 'number' ? start_seconds : undefined,
      endSeconds: typeof end_seconds === 'number' ? end_seconds : undefined,
    });
    if (!overlay) {
      res.status(404).json({ error: 'Text overlay not found' });
      return;
    }
    res.status(200).json({ text_overlay: overlay });
  } catch (err) {
    console.error('[projects] Error updating text overlay:', err);
    res.status(500).json({ error: 'Failed to update text overlay' });
  }
});

// DELETE /api/projects/:id/text/:textId
projectsRouter.delete('/:id/text/:textId', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const ok = await deleteTextOverlay(req.params.id as string, req.user.dbUserId, req.params.textId as string);
    if (!ok) {
      res.status(404).json({ error: 'Text overlay not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    console.error('[projects] Error deleting text overlay:', err);
    res.status(500).json({ error: 'Failed to delete text overlay' });
  }
});

// ─── Audio clips (SC4 — multi-clip Audio track) ────────────────────────────────

// POST /api/projects/:id/audio — add an audio clip, either a fresh upload OR a preset-music copy
projectsRouter.post('/:id/audio', audioUpload.single('file'), async (req: Request, res: Response) => {
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
      .from(projectAudioClips)
      .where(eq(projectAudioClips.project_id, projectId));
    if (Number(count) >= MAX_AUDIO_CLIPS_PER_PROJECT) {
      res.status(400).json({ error: `Project already has the maximum of ${MAX_AUDIO_CLIPS_PER_PROJECT} audio clips` });
      return;
    }

    const startOffsetSeconds = parseOptionalNumber(req.body?.start_offset_seconds);
    const trimStartSeconds = parseOptionalNumber(req.body?.trim_start_seconds);
    const trimEndSeconds = parseOptionalNumber(req.body?.trim_end_seconds);

    let r2Key: string;
    let sourceType: 'upload' | 'preset';

    if (req.file) {
      const ext = ALLOWED_AUDIO_MIMES[req.file.mimetype];
      if (!ext) {
        res.status(400).json({ error: 'Unsupported audio file type' });
        return;
      }
      r2Key = `projects/${projectId}/audio/${randomUUID()}.${ext}`;
      await r2.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: r2Key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
        }),
      );
      sourceType = 'upload';
    } else if (req.body?.source_type === 'preset' && typeof req.body?.preset_music_id === 'string') {
      const track = PRESET_MUSIC.find((t) => t.id === req.body.preset_music_id);
      if (!track) {
        res.status(400).json({ error: 'Unknown preset_music_id' });
        return;
      }
      r2Key = `projects/${projectId}/audio/${randomUUID()}.m4a`;
      await r2.send(
        new CopyObjectCommand({
          Bucket: R2_BUCKET,
          CopySource: `${R2_BUCKET}/${track.r2Key}`,
          Key: r2Key,
        }),
      );
      sourceType = 'preset';
    } else {
      res.status(400).json({ error: 'Provide a file upload, or { source_type: "preset", preset_music_id }' });
      return;
    }

    const audioClip = await addAudioClip(projectId, req.user.dbUserId, {
      r2Key,
      sourceType,
      startOffsetSeconds,
      trimStartSeconds,
      trimEndSeconds,
    });
    if (!audioClip) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.status(201).json({ audio_clip: audioClip });
  } catch (err) {
    console.error('[projects] Error adding audio clip:', err);
    res.status(500).json({ error: 'Failed to add audio clip' });
  }
});

// PATCH /api/projects/:id/audio/:audioId — reposition/retrim an audio clip
projectsRouter.patch('/:id/audio/:audioId', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const { start_offset_seconds, trim_start_seconds, trim_end_seconds, sort_order } = req.body ?? {};

  const updates: {
    startOffsetSeconds?: number;
    trimStartSeconds?: number;
    trimEndSeconds?: number;
    sortOrder?: number;
  } = {};
  if (start_offset_seconds !== undefined) {
    if (typeof start_offset_seconds !== 'number' || start_offset_seconds < 0) {
      res.status(400).json({ error: 'start_offset_seconds must be a non-negative number' });
      return;
    }
    updates.startOffsetSeconds = start_offset_seconds;
  }
  if (trim_start_seconds !== undefined) {
    if (typeof trim_start_seconds !== 'number' || trim_start_seconds < 0) {
      res.status(400).json({ error: 'trim_start_seconds must be a non-negative number' });
      return;
    }
    updates.trimStartSeconds = trim_start_seconds;
  }
  if (trim_end_seconds !== undefined) {
    if (typeof trim_end_seconds !== 'number' || trim_end_seconds < 0) {
      res.status(400).json({ error: 'trim_end_seconds must be a non-negative number' });
      return;
    }
    updates.trimEndSeconds = trim_end_seconds;
  }
  if (sort_order !== undefined) {
    if (typeof sort_order !== 'number') {
      res.status(400).json({ error: 'sort_order must be a number' });
      return;
    }
    updates.sortOrder = sort_order;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No valid fields to update' });
    return;
  }

  try {
    const audioClip = await updateAudioClip(
      req.params.id as string,
      req.user.dbUserId,
      req.params.audioId as string,
      updates,
    );
    if (!audioClip) {
      res.status(404).json({ error: 'Audio clip not found' });
      return;
    }
    res.status(200).json({ audio_clip: audioClip });
  } catch (err) {
    console.error('[projects] Error updating audio clip:', err);
    res.status(500).json({ error: 'Failed to update audio clip' });
  }
});

// DELETE /api/projects/:id/audio/:audioId — remove an audio clip row + its R2 object
projectsRouter.delete('/:id/audio/:audioId', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const ok = await deleteAudioClip(req.params.id as string, req.user.dbUserId, req.params.audioId as string);
    if (!ok) {
      res.status(404).json({ error: 'Audio clip not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    console.error('[projects] Error deleting audio clip:', err);
    res.status(500).json({ error: 'Failed to delete audio clip' });
  }
});

// ─── Caption cues/words (SC5, D-13) ─────────────────────────────────────────────

// POST /api/projects/:id/captions — add a caption cue (+ its words)
projectsRouter.post('/:id/captions', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const projectId = req.params.id as string;
  const { start_seconds, end_seconds, words } = req.body ?? {};

  if (
    typeof start_seconds !== 'number' ||
    typeof end_seconds !== 'number' ||
    start_seconds < 0 ||
    start_seconds >= end_seconds
  ) {
    res.status(400).json({ error: 'Invalid start_seconds/end_seconds' });
    return;
  }
  if (words !== undefined) {
    const wordsError = validateCaptionWords(words);
    if (wordsError) {
      res.status(400).json(wordsError);
      return;
    }
  }

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
      .from(projectCaptionCues)
      .where(eq(projectCaptionCues.project_id, projectId));
    if (Number(count) >= MAX_CAPTION_CUES_PER_PROJECT) {
      res.status(400).json({ error: `Project already has the maximum of ${MAX_CAPTION_CUES_PER_PROJECT} caption cues` });
      return;
    }

    const cue = await addCaptionCue(projectId, req.user.dbUserId, {
      startSeconds: start_seconds,
      endSeconds: end_seconds,
      words: Array.isArray(words)
        ? (words as CaptionWordBody[]).map((w) => ({
            text: w.text,
            startSeconds: w.start_seconds,
            endSeconds: w.end_seconds,
          }))
        : undefined,
    });
    if (!cue) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.status(201).json({ caption_cue: cue });
  } catch (err) {
    console.error('[projects] Error adding caption cue:', err);
    res.status(500).json({ error: 'Failed to add caption cue' });
  }
});

// PATCH /api/projects/:id/captions/:cueId — retime a cue and/or replace its word list
projectsRouter.patch('/:id/captions/:cueId', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const { start_seconds, end_seconds, words } = req.body ?? {};

  if (start_seconds !== undefined && end_seconds !== undefined) {
    if (
      typeof start_seconds !== 'number' ||
      typeof end_seconds !== 'number' ||
      start_seconds < 0 ||
      start_seconds >= end_seconds
    ) {
      res.status(400).json({ error: 'Invalid start_seconds/end_seconds' });
      return;
    }
  } else if (start_seconds !== undefined && typeof start_seconds !== 'number') {
    res.status(400).json({ error: 'Invalid start_seconds/end_seconds' });
    return;
  } else if (end_seconds !== undefined && typeof end_seconds !== 'number') {
    res.status(400).json({ error: 'Invalid start_seconds/end_seconds' });
    return;
  }
  if (words !== undefined) {
    const wordsError = validateCaptionWords(words);
    if (wordsError) {
      res.status(400).json(wordsError);
      return;
    }
  }

  try {
    const cue = await updateCaptionCue(req.params.id as string, req.user.dbUserId, req.params.cueId as string, {
      startSeconds: typeof start_seconds === 'number' ? start_seconds : undefined,
      endSeconds: typeof end_seconds === 'number' ? end_seconds : undefined,
      words: Array.isArray(words)
        ? (words as CaptionWordBody[]).map((w) => ({
            text: w.text,
            startSeconds: w.start_seconds,
            endSeconds: w.end_seconds,
          }))
        : undefined,
    });
    if (!cue) {
      res.status(404).json({ error: 'Caption cue not found' });
      return;
    }
    res.status(200).json({ caption_cue: cue });
  } catch (err) {
    console.error('[projects] Error updating caption cue:', err);
    res.status(500).json({ error: 'Failed to update caption cue' });
  }
});

// DELETE /api/projects/:id/captions — bulk clear the ENTIRE Captions track (D-13). Registered
// as a distinct path shape from the single-cue delete below — no :cueId in the path.
projectsRouter.delete('/:id/captions', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const ok = await deleteAllCaptions(req.params.id as string, req.user.dbUserId);
    if (!ok) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    console.error('[projects] Error deleting all captions:', err);
    res.status(500).json({ error: 'Failed to delete all captions' });
  }
});

// DELETE /api/projects/:id/captions/:cueId — delete a single cue (+ its words)
projectsRouter.delete('/:id/captions/:cueId', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const ok = await deleteCaptionCue(req.params.id as string, req.user.dbUserId, req.params.cueId as string);
    if (!ok) {
      res.status(404).json({ error: 'Caption cue not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    console.error('[projects] Error deleting caption cue:', err);
    res.status(500).json({ error: 'Failed to delete caption cue' });
  }
});

