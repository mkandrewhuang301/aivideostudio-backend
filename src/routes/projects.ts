// src/routes/projects.ts
// Phase 13 (Edit Studio): project hub + editor-state CRUD.
// Every handler starts with the req.user?.dbUserId auth guard, and every query is scoped by
// user_id (directly for project rows, via a project-ownership resolution for child rows) —
// mirrors the IDOR pattern established in uploads.ts/generations.ts (T-13-07).

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PutObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../storage/r2';
import { probeDurationSeconds, probeVideoMeta } from '../services/mediaProbe';
import { db } from '../db/client';
import {
  projects,
  projectClips,
  projectTextOverlays,
  projectAudioClips,
  projectCaptionCues,
  generations,
} from '../db/schema';
import { eq, and, sql, isNull, asc } from 'drizzle-orm';
import { getUploadPresignedUrl } from '../services/archivalService';
import { PRESET_MUSIC } from '../config/presetMusic';
import { ffmpegQueue } from '../queue/ffmpegWorker';
import { createGeneration } from '../services/generationService';
import { transcribeToWordCues, TranscriptionError } from '../services/captionTranscriptionService';
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
  splitClip,
  splitAudioClip,
  SplitValidationError,
  softDeleteClip,
  restoreClip,
  restoreAudioClip,
  translateCaptionDraftsToProjectTimeline,
  setProjectCover,
  setProjectCoverFromUpload,
} from '../services/projectService';
import { resequenceAudioClipSortOrder, resequenceClipSortOrder } from '../services/clipResequence';

export const projectsRouter = Router();

// Plan 13-22 B2: 'original' = the first clip's exact native ratio (not snapped to a preset).
const VALID_ASPECT_RATIOS = ['original', '9:16', '4:5', '1:1', '16:9'];
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

// Plan 13-24 K-B1: cover image upload (composited JPEG/PNG/etc from the cover editor).
const ALLOWED_COVER_MIMES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heic',
};

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — still cover frames, not video
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype in ALLOWED_COVER_MIMES);
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

// POST /api/projects/:id/cover — set a custom project cover.
// Plan 13-21 B3 JSON branch: {clip_id, at_seconds} → extract frame / CopyObject.
// Plan 13-24 K-B1 multipart branch: file field → store under projects/{id}/cover/.
// Both return a fresh presigned thumbnail_url.
projectsRouter.post('/:id/cover', coverUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  // Multipart branch (K-B1): client-composited cover image.
  if (req.file) {
    try {
      const ext = ALLOWED_COVER_MIMES[req.file.mimetype];
      const result = await setProjectCoverFromUpload(
        req.params.id as string,
        req.user.dbUserId,
        req.file.buffer,
        req.file.mimetype,
        ext,
      );
      if (!result) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.status(200).json({ thumbnail_url: result.thumbnailUrl });
    } catch (err) {
      console.error('[projects] Error uploading project cover:', err);
      res.status(500).json({ error: 'Failed to set project cover' });
    }
    return;
  }

  // Multipart request that arrived without an accepted file → bad/missing mime.
  if (req.is('multipart/form-data')) {
    res.status(400).json({ error: 'No file provided or unsupported file type' });
    return;
  }

  // JSON branch (Plan 13-21 B3) — unchanged.
  const { clip_id, at_seconds } = req.body ?? {};
  if (typeof clip_id !== 'string' || clip_id.length === 0) {
    res.status(400).json({ error: 'clip_id is required' });
    return;
  }
  if (typeof at_seconds !== 'number' || !Number.isFinite(at_seconds) || at_seconds < 0) {
    res.status(400).json({ error: 'at_seconds must be a non-negative number' });
    return;
  }
  try {
    const result = await setProjectCover(req.params.id as string, req.user.dbUserId, clip_id, at_seconds);
    if (!result) {
      res.status(404).json({ error: 'Project or clip not found' });
      return;
    }
    res.status(200).json({ thumbnail_url: result.thumbnailUrl });
  } catch (err) {
    console.error('[projects] Error setting project cover:', err);
    res.status(500).json({ error: 'Failed to set project cover' });
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
      .where(and(eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)));
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

      // B1 (Plan 13-20, extended by Plan 13-22 B1): derive a real duration + pixel dimensions at
      // import time — the root cause of the 0:00-total/black-preview bug was
      // original_duration_seconds never being written; width/height power the "Original" canvas
      // aspect ratio. Images get a fixed CapCut-style still duration but still get probed for
      // dimensions (ffprobe reads image pixel size too). Probe failure must never fail the import
      // — leaves durationSeconds/width/height undefined (persisted as null, self-healed later by
      // getProjectWithState).
      let durationSeconds: number | undefined;
      let width: number | undefined;
      let height: number | undefined;
      const tempPath = path.join(tmpdir(), `clip-probe-${randomUUID()}.${ext}`);
      try {
        await writeFile(tempPath, req.file.buffer);
        const meta = await probeVideoMeta(tempPath);
        width = meta.width ?? undefined;
        height = meta.height ?? undefined;
        durationSeconds = mediaType === 'video' ? meta.durationSeconds ?? undefined : 3;
      } finally {
        await unlink(tempPath).catch(() => {});
      }

      const clip = await importClipByCopy({
        projectId,
        userId: req.user.dbUserId,
        sourceType: 'upload',
        uploadedR2Key: key,
        mimeType: req.file.mimetype,
        mediaType,
        durationSeconds,
        width,
        height,
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
  const trimWasUpdated = trim_start_seconds !== undefined || trim_end_seconds !== undefined;

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
    let requestedSortOrder: number | undefined;
    if (sort_order !== undefined) {
      if (typeof sort_order !== 'number') {
        res.status(400).json({ error: 'sort_order must be a number' });
        return;
      }
      requestedSortOrder = sort_order;
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
    if (Object.keys(setValues).length === 0 && requestedSortOrder === undefined) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    const captionStalenessResponse = async (): Promise<{ captions_may_be_stale?: true }> => {
      if (!trimWasUpdated) return {};
      const [captionCue] = await db
        .select({ id: projectCaptionCues.id })
        .from(projectCaptionCues)
        .where(eq(projectCaptionCues.project_id, projectId))
        .limit(1);
      return captionCue ? { captions_may_be_stale: true } : {};
    };

    // Plan 13-25 L6: sort_order uses move-semantics resequence (dense 0..n-1), not a naive SET.
    if (requestedSortOrder !== undefined) {
      const resequenced = await resequenceClipSortOrder(projectId, clipId, requestedSortOrder);
      if (!resequenced) {
        res.status(404).json({ error: 'Clip not found' });
        return;
      }
      if (Object.keys(setValues).length > 0) {
        const [clip] = await db
          .update(projectClips)
          .set(setValues)
          .where(
            and(eq(projectClips.id, clipId), eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)),
          )
          .returning();
        if (!clip) {
          res.status(404).json({ error: 'Clip not found' });
          return;
        }
        res.status(200).json({ clip, ...(await captionStalenessResponse()) });
        return;
      }
      res.status(200).json({ clip: resequenced, ...(await captionStalenessResponse()) });
      return;
    }

    const [clip] = await db
      .update(projectClips)
      .set(setValues)
      .where(
        and(eq(projectClips.id, clipId), eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)),
      )
      .returning();
    if (!clip) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }
    res.status(200).json({ clip, ...(await captionStalenessResponse()) });
  } catch (err) {
    console.error('[projects] Error updating clip:', err);
    res.status(500).json({ error: 'Failed to update clip' });
  }
});

// DELETE /api/projects/:id/clips/:clipId — soft-delete (Plan 13-21 B1): sets deleted_at, keeps
// the row + R2 object so undo can fully restore it via the /restore endpoint below. Route
// signature/response shape unchanged — iOS callers don't change.
projectsRouter.delete('/:id/clips/:clipId', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const projectId = req.params.id as string;
  const clipId = req.params.clipId as string;
  try {
    const ok = await softDeleteClip(projectId, req.user.dbUserId, clipId);
    if (!ok) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    console.error('[projects] Error deleting clip:', err);
    res.status(500).json({ error: 'Failed to delete clip' });
  }
});

// POST /api/projects/:id/clips/:clipId/restore — undo a clip delete (Plan 13-21 B1.3)
projectsRouter.post('/:id/clips/:clipId/restore', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const clip = await restoreClip(req.params.id as string, req.user.dbUserId, req.params.clipId as string);
    if (!clip) {
      res.status(404).json({ error: 'Clip not found, not deleted, or already purged' });
      return;
    }
    res.status(200).json({ clip });
  } catch (err) {
    console.error('[projects] Error restoring clip:', err);
    res.status(500).json({ error: 'Failed to restore clip' });
  }
});

// POST /api/projects/:id/clips/:clipId/split — cut a clip into two adjacent pieces at a local
// trim-seconds split point (T-13-19 Task G1). Copy-then-insert (never shares one r2_key across
// two rows, mirrors importClipByCopy) — CopyObjects the source clip's r2_key to a fresh key,
// inserts the new second-half clip, resequences trailing clips, and shrinks the original's
// trim_end_seconds to the split point, all scoped by the existing MAX_CLIPS_PER_PROJECT cap.
projectsRouter.post('/:id/clips/:clipId/split', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const projectId = req.params.id as string;
  const clipId = req.params.clipId as string;
  const { original_trim_end, new_trim_start, new_trim_end, new_sort_order } = req.body ?? {};

  if (
    typeof original_trim_end !== 'number' ||
    typeof new_trim_start !== 'number' ||
    typeof new_trim_end !== 'number' ||
    typeof new_sort_order !== 'number'
  ) {
    res.status(400).json({ error: 'original_trim_end, new_trim_start, new_trim_end, new_sort_order are required numbers' });
    return;
  }
  if (new_trim_start >= new_trim_end) {
    res.status(400).json({ error: 'new_trim_start must be less than new_trim_end' });
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
      .from(projectClips)
      .where(and(eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)));
    if (Number(count) >= MAX_CLIPS_PER_PROJECT) {
      res.status(400).json({ error: `Project already has the maximum of ${MAX_CLIPS_PER_PROJECT} clips` });
      return;
    }

    const result = await splitClip(projectId, req.user.dbUserId, clipId, {
      originalTrimEnd: original_trim_end,
      newTrimStart: new_trim_start,
      newTrimEnd: new_trim_end,
      newSortOrder: new_sort_order,
    });
    if (!result) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }

    res.status(201).json({ clip: result.newClip, original_clip: result.originalClip });
  } catch (err) {
    if (err instanceof SplitValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[projects] Error splitting clip:', err);
    res.status(500).json({ error: 'Failed to split clip' });
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
      .where(and(eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)));
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
  const { text, x_norm, y_norm, width_norm, rotation, row_index, start_seconds, end_seconds } = req.body ?? {};

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
  if (rotation !== undefined && (typeof rotation !== 'number' || rotation < -360 || rotation > 360)) {
    res.status(400).json({ error: 'rotation must be between -360 and 360' });
    return;
  }
  if (
    row_index !== undefined &&
    (typeof row_index !== 'number' || !Number.isInteger(row_index) || row_index < 0 || row_index > 50)
  ) {
    res.status(400).json({ error: 'row_index must be an integer between 0 and 50' });
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
      rotation: typeof rotation === 'number' ? rotation : undefined,
      rowIndex: typeof row_index === 'number' ? row_index : undefined,
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
  const { text, x_norm, y_norm, width_norm, rotation, row_index, start_seconds, end_seconds } = req.body ?? {};

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
  if (rotation !== undefined && (typeof rotation !== 'number' || rotation < -360 || rotation > 360)) {
    res.status(400).json({ error: 'rotation must be between -360 and 360' });
    return;
  }
  if (
    row_index !== undefined &&
    (typeof row_index !== 'number' || !Number.isInteger(row_index) || row_index < 0 || row_index > 50)
  ) {
    res.status(400).json({ error: 'row_index must be an integer between 0 and 50' });
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
      rotation: typeof rotation === 'number' ? rotation : undefined,
      rowIndex: typeof row_index === 'number' ? row_index : undefined,
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
      .where(and(eq(projectAudioClips.project_id, projectId), isNull(projectAudioClips.deleted_at)));
    if (Number(count) >= MAX_AUDIO_CLIPS_PER_PROJECT) {
      res.status(400).json({ error: `Project already has the maximum of ${MAX_AUDIO_CLIPS_PER_PROJECT} audio clips` });
      return;
    }

    const startOffsetSeconds = parseOptionalNumber(req.body?.start_offset_seconds);
    const trimStartSeconds = parseOptionalNumber(req.body?.trim_start_seconds);
    const trimEndSeconds = parseOptionalNumber(req.body?.trim_end_seconds);

    let r2Key: string;
    let sourceType: 'upload' | 'preset';
    // B2: probe the real duration at add-time (mirrors clips' probe-at-import) — fixes audio
    // split's "silently does nothing" bug (the root cause was trim_end_seconds being the ONLY
    // fallback, always null for untrimmed audio). Probe failure must never fail the add.
    let originalDurationSeconds: number | undefined;

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

      const tempPath = path.join(tmpdir(), `audio-probe-${randomUUID()}.${ext}`);
      try {
        await writeFile(tempPath, req.file.buffer);
        originalDurationSeconds = (await probeDurationSeconds(tempPath)) ?? undefined;
      } finally {
        await unlink(tempPath).catch(() => {});
      }
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

      const presignedUrl = await getUploadPresignedUrl(r2Key);
      originalDurationSeconds = (await probeDurationSeconds(presignedUrl)) ?? undefined;
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
      originalDurationSeconds,
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
  const projectId = req.params.id as string;
  const audioId = req.params.audioId as string;
  const { start_offset_seconds, trim_start_seconds, trim_end_seconds, sort_order } = req.body ?? {};

  const trimUpdates: {
    startOffsetSeconds?: number;
    trimStartSeconds?: number;
    trimEndSeconds?: number;
  } = {};
  let requestedSortOrder: number | undefined;
  if (start_offset_seconds !== undefined) {
    if (typeof start_offset_seconds !== 'number' || start_offset_seconds < 0) {
      res.status(400).json({ error: 'start_offset_seconds must be a non-negative number' });
      return;
    }
    trimUpdates.startOffsetSeconds = start_offset_seconds;
  }
  if (trim_start_seconds !== undefined) {
    if (typeof trim_start_seconds !== 'number' || trim_start_seconds < 0) {
      res.status(400).json({ error: 'trim_start_seconds must be a non-negative number' });
      return;
    }
    trimUpdates.trimStartSeconds = trim_start_seconds;
  }
  if (trim_end_seconds !== undefined) {
    if (typeof trim_end_seconds !== 'number' || trim_end_seconds < 0) {
      res.status(400).json({ error: 'trim_end_seconds must be a non-negative number' });
      return;
    }
    trimUpdates.trimEndSeconds = trim_end_seconds;
  }
  if (sort_order !== undefined) {
    if (typeof sort_order !== 'number') {
      res.status(400).json({ error: 'sort_order must be a number' });
      return;
    }
    requestedSortOrder = sort_order;
  }
  if (Object.keys(trimUpdates).length === 0 && requestedSortOrder === undefined) {
    res.status(400).json({ error: 'No valid fields to update' });
    return;
  }

  try {
    // Plan 13-25 L6: sort_order uses move-semantics resequence (dense 0..n-1), not a naive SET.
    if (requestedSortOrder !== undefined) {
      const [ownedProject] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.user_id, req.user.dbUserId)));
      if (!ownedProject) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const resequenced = await resequenceAudioClipSortOrder(projectId, audioId, requestedSortOrder);
      if (!resequenced) {
        res.status(404).json({ error: 'Audio clip not found' });
        return;
      }
      if (Object.keys(trimUpdates).length > 0) {
        const audioClip = await updateAudioClip(projectId, req.user.dbUserId, audioId, trimUpdates);
        if (!audioClip) {
          res.status(404).json({ error: 'Audio clip not found' });
          return;
        }
        res.status(200).json({ audio_clip: audioClip });
        return;
      }
      res.status(200).json({ audio_clip: resequenced });
      return;
    }

    const audioClip = await updateAudioClip(projectId, req.user.dbUserId, audioId, trimUpdates);
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

// DELETE /api/projects/:id/audio/:audioId — soft-delete (Plan 13-21 B1): sets deleted_at, keeps
// the row + R2 object so undo can fully restore it via the /restore endpoint below.
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

// POST /api/projects/:id/audio/:audioId/restore — undo an audio clip delete (Plan 13-21 B1.3)
projectsRouter.post('/:id/audio/:audioId/restore', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const audioClip = await restoreAudioClip(req.params.id as string, req.user.dbUserId, req.params.audioId as string);
    if (!audioClip) {
      res.status(404).json({ error: 'Audio clip not found, not deleted, or already purged' });
      return;
    }
    res.status(200).json({ audio_clip: audioClip });
  } catch (err) {
    console.error('[projects] Error restoring audio clip:', err);
    res.status(500).json({ error: 'Failed to restore audio clip' });
  }
});

// POST /api/projects/:id/audio/:audioId/split — cut an audio clip into two adjacent pieces at a
// local trim-seconds split point (T-13-19 Task G2). Same copy-then-insert shape as the clip split
// above; the second piece is appended at the next sort_order (audio timeline position is driven
// by start_offset_seconds, not sort_order, so no resequencing is needed).
projectsRouter.post('/:id/audio/:audioId/split', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const projectId = req.params.id as string;
  const audioId = req.params.audioId as string;
  const { original_trim_end, new_trim_start, new_trim_end, new_start_offset_seconds } = req.body ?? {};

  if (
    typeof original_trim_end !== 'number' ||
    typeof new_trim_start !== 'number' ||
    typeof new_trim_end !== 'number' ||
    typeof new_start_offset_seconds !== 'number'
  ) {
    res
      .status(400)
      .json({ error: 'original_trim_end, new_trim_start, new_trim_end, new_start_offset_seconds are required numbers' });
    return;
  }
  if (new_trim_start >= new_trim_end) {
    res.status(400).json({ error: 'new_trim_start must be less than new_trim_end' });
    return;
  }
  if (new_start_offset_seconds < 0) {
    res.status(400).json({ error: 'new_start_offset_seconds must be non-negative' });
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
      .from(projectAudioClips)
      .where(and(eq(projectAudioClips.project_id, projectId), isNull(projectAudioClips.deleted_at)));
    if (Number(count) >= MAX_AUDIO_CLIPS_PER_PROJECT) {
      res.status(400).json({ error: `Project already has the maximum of ${MAX_AUDIO_CLIPS_PER_PROJECT} audio clips` });
      return;
    }

    const result = await splitAudioClip(projectId, req.user.dbUserId, audioId, {
      originalTrimEnd: original_trim_end,
      newTrimStart: new_trim_start,
      newTrimEnd: new_trim_end,
      newStartOffsetSeconds: new_start_offset_seconds,
    });
    if (!result) {
      res.status(404).json({ error: 'Audio clip not found' });
      return;
    }

    res.status(201).json({ audio_clip: result.newAudioClip, original_audio_clip: result.originalAudioClip });
  } catch (err) {
    if (err instanceof SplitValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[projects] Error splitting audio clip:', err);
    res.status(500).json({ error: 'Failed to split audio clip' });
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

// POST /api/projects/:id/clips/:clipId/captions/auto-generate — SC5 auto-captions: transcribes
// the clip's audio (Whisper word-level) and persists each resulting cue via addCaptionCue. This
// is the synchronous path behind the UI's "Auto-generate from this clip's audio" /
// "Transcribing…" state (mirrors the Magic Editor synchronous OpenAI precedent, 09.2-08) — a
// transcription failure surfaces as a clean 502, never a silent empty result.
projectsRouter.post('/:id/clips/:clipId/captions/auto-generate', async (req: Request, res: Response) => {
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

    const clipRows = await db
      .select({
        id: projectClips.id,
        r2_key: projectClips.r2_key,
        trim_start_seconds: projectClips.trim_start_seconds,
        trim_end_seconds: projectClips.trim_end_seconds,
        original_duration_seconds: projectClips.original_duration_seconds,
      })
      .from(projectClips)
      .where(and(eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)))
      .orderBy(asc(projectClips.sort_order), asc(projectClips.created_at));
    const clip = clipRows.find((row) => row.id === clipId);
    if (!clip) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }

    let cueDrafts;
    try {
      cueDrafts = await transcribeToWordCues(clip.r2_key);
    } catch (transcribeErr) {
      if (transcribeErr instanceof TranscriptionError) {
        console.error('[projects] Transcription failed:', transcribeErr);
        res.status(502).json({ error: 'Transcription failed' });
        return;
      }
      throw transcribeErr;
    }

    const translatedDrafts = translateCaptionDraftsToProjectTimeline(
      cueDrafts,
      clipRows.map((row) => ({
        id: row.id,
        trimStartSeconds: row.trim_start_seconds,
        trimEndSeconds: row.trim_end_seconds,
        originalDurationSeconds: row.original_duration_seconds,
      })),
      clipId,
    );

    const cues = [];
    for (const draft of translatedDrafts) {
      const cue = await addCaptionCue(projectId, req.user.dbUserId, {
        startSeconds: draft.startSeconds,
        endSeconds: draft.endSeconds,
        words: (draft.words ?? []).map((w) => ({
          text: w.text,
          startSeconds: w.startSeconds,
          endSeconds: w.endSeconds,
        })),
      });
      if (cue) cues.push(cue);
    }

    res.status(200).json({ cues });
  } catch (err) {
    console.error('[projects] Error auto-generating captions:', err);
    res.status(500).json({ error: 'Failed to auto-generate captions' });
  }
});
