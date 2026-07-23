// src/services/projectService.ts
// Phase 13 (Edit Studio): project CRUD, import-by-copy (D-03), and the generalized
// "smart unpack" import hook (D-15/D-16). Every function that touches a project or a
// generation ownership-scopes its query by user_id — no unscoped lookups (T-13-07/T-13-08).
//
// CLAUDE.md Rule 2 (provider URLs expire) applies equally to R2 presigned URLs here:
// getProjectWithState/listProjects never return a bare r2_key — always a fresh presigned url
// generated at query time via archivalService.getUploadPresignedUrl (1h TTL).

import { randomUUID } from 'crypto';
import { CopyObjectCommand, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../storage/r2';
import { db } from '../db/client';
import {
  projects,
  projectClips,
  projectTextOverlays,
  projectAudioClips,
  projectCaptionCues,
  projectCaptionWords,
  generations,
} from '../db/schema';
import type {
  Project,
  NewProject,
  ProjectClip,
  ProjectTextOverlay,
  ProjectAudioClip,
  ProjectCaptionCue,
  ProjectCaptionWord,
} from '../db/schema';
import { eq, and, desc, lt, or, sql, inArray, isNull, isNotNull } from 'drizzle-orm';
import { getUploadPresignedUrl } from './archivalService';
import { extractVideoFrame } from './frameExtractor';
import { probeDurationSeconds, probeVideoMeta } from './mediaProbe';
import type { ComposeSpec, ComposeCaptionCue, ComposeCaptionStyle } from '../queue/ffmpegWorker';

// DoS guard (T-13-10): route layer enforces this cap before calling importClipByCopy.
export const MAX_CLIPS_PER_PROJECT = 50;
// DoS guards (T-13-16) for the element tracks added in Plan 04.
export const MAX_TEXT_OVERLAYS_PER_PROJECT = 30;
export const MAX_AUDIO_CLIPS_PER_PROJECT = 10;
export const MAX_CAPTION_CUES_PER_PROJECT = 200;
export const MAX_WORDS_PER_CUE = 40;

// Thrown by importClipByCopy when the source generation doesn't exist, isn't owned by the
// requesting user, or isn't completed yet — the route maps this to a 404, never a 500.
export class ImportSourceNotFoundError extends Error {}

// Thrown by buildComposeSnapshot when a clip or audio clip has no resolvable trim_end_seconds
// (neither an explicit trim nor, for clips, a fallback original_duration_seconds) — the compose
// worker's filter_complex graph requires a concrete numeric duration per input (RESEARCH.md
// Pattern 1's ComposeClipSpec/ComposeAudioSpec both declare trimEndSeconds as non-optional).
// The route maps this to a 400, never lets an incomplete spec reach the ffmpeg queue.
export class ExportValidationError extends Error {}

// Thrown by splitClip/splitAudioClip when the requested split point isn't STRICTLY inside the
// source asset's current trim range (T-13-19 Task G1/G2) — the route maps this to a 400, never a
// silent no-op or a malformed zero-duration piece.
export class SplitValidationError extends Error {}

// Shared ownership resolution (T-13-15): every element (text/audio/caption) handler below
// resolves the PARENT project scoped to user_id FIRST, before mutating any child row — never
// a bare child-id update. Returns false for both "project doesn't exist" and "not owned by
// this user" — the route layer maps false/null to a 404, indistinguishable from either case.
async function isProjectOwned(projectId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)));
  return !!row;
}

// Plan 13-21 B1.5: lazy purge — called at the top of getProjectWithState (the read path every
// editor open/refresh hits) so soft-deleted rows older than 24h are reaped with zero cron/worker
// infra. Best-effort R2 delete per row (a stray object past the undo window is a minor storage
// cost, matches deleteProject's established convention), then a hard DELETE of the row itself.
async function purgeExpiredSoftDeletes(projectId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [expiredClips, expiredAudio] = await Promise.all([
    db
      .select({ id: projectClips.id, r2_key: projectClips.r2_key })
      .from(projectClips)
      .where(
        and(
          eq(projectClips.project_id, projectId),
          isNotNull(projectClips.deleted_at),
          lt(projectClips.deleted_at, cutoff),
        ),
      ),
    db
      .select({ id: projectAudioClips.id, r2_key: projectAudioClips.r2_key })
      .from(projectAudioClips)
      .where(
        and(
          eq(projectAudioClips.project_id, projectId),
          isNotNull(projectAudioClips.deleted_at),
          lt(projectAudioClips.deleted_at, cutoff),
        ),
      ),
  ]);

  for (const clip of expiredClips) {
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: clip.r2_key }));
    } catch (err) {
      console.error('[projectService] Best-effort purge R2 delete failed for clip', clip.id, err);
    }
    await db.delete(projectClips).where(eq(projectClips.id, clip.id));
  }
  for (const audio of expiredAudio) {
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: audio.r2_key }));
    } catch (err) {
      console.error('[projectService] Best-effort purge R2 delete failed for audio clip', audio.id, err);
    }
    await db.delete(projectAudioClips).where(eq(projectAudioClips.id, audio.id));
  }
}

// ─── Project CRUD ──────────────────────────────────────────────────────────────

export async function createProject(
  userId: string,
  opts: { title?: string | null; aspectRatio?: string } = {},
): Promise<Project> {
  const [row] = await db
    .insert(projects)
    .values({
      user_id: userId,
      title: opts.title ?? null,
      // Plan 13-22 B2: 'original' (the first clip's exact native ratio, not a snapped preset) is
      // the default for new projects — matches the CapCut-style "don't force a crop" UX decision.
      aspect_ratio: opts.aspectRatio ?? 'original',
    })
    .returning();
  return row;
}

// Cursor-list, newest-first — mirrors listGenerations exactly (07-02 pattern).
export async function listProjects(
  userId: string,
  cursor?: { createdAt: Date; id: string },
  limit = 20,
): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.user_id, userId),
        cursor
          ? or(
              lt(projects.created_at, cursor.createdAt),
              and(eq(projects.created_at, cursor.createdAt), lt(projects.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(projects.created_at), desc(projects.id))
    .limit(limit);
}

export interface ProjectClipWithUrl extends Omit<ProjectClip, 'r2_key'> {
  url: string;
}
export interface ProjectAudioClipWithUrl extends Omit<ProjectAudioClip, 'r2_key'> {
  url: string;
}
export interface ProjectCaptionCueWithWords extends ProjectCaptionCue {
  words: ProjectCaptionWord[];
}
export interface FullProjectState extends Omit<Project, 'thumbnail_r2_key'> {
  thumbnail_url: string | null;
  clips: ProjectClipWithUrl[];
  text_overlays: ProjectTextOverlay[];
  audio_clips: ProjectAudioClipWithUrl[];
  caption_cues: ProjectCaptionCueWithWords[];
}

// IDOR guard: userId in WHERE — returns null (never another user's row) for a not-found/not-owned project.
// Presigns every clip/audio r2_key fresh (CLAUDE.md Rule 2) — raw r2_key is stripped before returning.
export async function getProjectWithState(
  projectId: string,
  userId: string,
): Promise<FullProjectState | null> {
  const [projectRow] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)));
  if (!projectRow) return null;

  // B1.5: reap soft-deletes past the 24h undo window before reading — best-effort, never blocks.
  try {
    await purgeExpiredSoftDeletes(projectId);
  } catch (err) {
    console.error('[projectService] purgeExpiredSoftDeletes failed (non-blocking):', err);
  }

  const [clipRows, textRows, audioRows, cueRows] = await Promise.all([
    db
      .select()
      .from(projectClips)
      .where(and(eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)))
      .orderBy(projectClips.sort_order),
    db
      .select()
      .from(projectTextOverlays)
      .where(eq(projectTextOverlays.project_id, projectId))
      .orderBy(projectTextOverlays.start_seconds),
    db
      .select()
      .from(projectAudioClips)
      .where(and(eq(projectAudioClips.project_id, projectId), isNull(projectAudioClips.deleted_at)))
      .orderBy(projectAudioClips.sort_order),
    db
      .select()
      .from(projectCaptionCues)
      .where(eq(projectCaptionCues.project_id, projectId))
      .orderBy(projectCaptionCues.sort_order),
  ]);

  const cueIds = cueRows.map((c) => c.id);
  const wordRows =
    cueIds.length > 0
      ? await db
          .select()
          .from(projectCaptionWords)
          .where(inArray(projectCaptionWords.cue_id, cueIds))
          .orderBy(projectCaptionWords.sort_order)
      : [];
  const wordsByCue: Record<string, ProjectCaptionWord[]> = {};
  for (const w of wordRows) {
    (wordsByCue[w.cue_id] ??= []).push(w);
  }

  const clips: ProjectClipWithUrl[] = await Promise.all(
    clipRows.map(async (c) => {
      const { r2_key, ...rest } = c;
      const url = await getUploadPresignedUrl(r2_key);

      // B1.4 self-heal (Plan 13-20, extended by Plan 13-22 B1): rows imported before the
      // ffprobe-at-import fix (or whose probe failed at the time) carry a null duration and/or
      // null width/height — backfill both here so every existing project fixes itself with zero
      // manual steps. Best-effort per clip; a probe failure still returns the project (with
      // whichever fields stay unresolved left null).
      let original_duration_seconds = rest.original_duration_seconds;
      let width = rest.width;
      let height = rest.height;
      if (original_duration_seconds == null || width == null || height == null) {
        try {
          const meta = await probeVideoMeta(url);
          const updates: { original_duration_seconds?: number; width?: number; height?: number } = {};

          if (original_duration_seconds == null) {
            original_duration_seconds = c.media_type === 'image' ? 3 : meta.durationSeconds;
            if (original_duration_seconds != null) updates.original_duration_seconds = original_duration_seconds;
          }
          if (width == null && meta.width != null) {
            width = meta.width;
            updates.width = meta.width;
          }
          if (height == null && meta.height != null) {
            height = meta.height;
            updates.height = meta.height;
          }

          if (Object.keys(updates).length > 0) {
            await db.update(projectClips).set(updates).where(eq(projectClips.id, c.id));
          }
        } catch (err) {
          console.error('[projectService] Self-heal duration/dimensions probe failed for clip', c.id, err);
        }
      }

      return { ...rest, original_duration_seconds, width, height, url };
    }),
  );
  const audioClips: ProjectAudioClipWithUrl[] = await Promise.all(
    audioRows.map(async (a) => {
      const { r2_key, ...rest } = a;
      const url = await getUploadPresignedUrl(r2_key);

      // B2.2 self-heal (Plan 13-21): audio clips added before the probe-at-add fix (or whose
      // probe failed at add time) carry a null original_duration_seconds — backfill exactly like
      // clips' self-heal above. Best-effort; a probe failure just leaves it null.
      let original_duration_seconds = rest.original_duration_seconds;
      if (original_duration_seconds == null) {
        try {
          original_duration_seconds = await probeDurationSeconds(url);
          if (original_duration_seconds != null) {
            await db
              .update(projectAudioClips)
              .set({ original_duration_seconds })
              .where(eq(projectAudioClips.id, a.id));
          }
        } catch (err) {
          console.error('[projectService] Self-heal duration probe failed for audio clip', a.id, err);
        }
      }

      return { ...rest, original_duration_seconds, url };
    }),
  );
  const thumbnailUrl = projectRow.thumbnail_r2_key
    ? await getUploadPresignedUrl(projectRow.thumbnail_r2_key)
    : null;

  const projectFields: Record<string, unknown> = { ...projectRow };
  delete projectFields.thumbnail_r2_key;
  return {
    ...projectFields,
    thumbnail_url: thumbnailUrl,
    clips,
    text_overlays: textRows,
    audio_clips: audioClips,
    caption_cues: cueRows.map((c) => ({ ...c, words: wordsByCue[c.id] ?? [] })),
  } as FullProjectState;
}

// Partial update — caller (route layer) is responsible for validating aspectRatio/captionStyle.position
// against their fixed enums before calling this. Returns null if not owned/not found (0 rows updated).
export async function updateProject(
  projectId: string,
  userId: string,
  updates: { title?: string | null; aspectRatio?: string; captionStyle?: Record<string, unknown> },
): Promise<Project | null> {
  const setValues: Partial<NewProject> = { updated_at: new Date() };
  if (updates.title !== undefined) setValues.title = updates.title;
  if (updates.aspectRatio !== undefined) setValues.aspect_ratio = updates.aspectRatio;
  if (updates.captionStyle !== undefined) setValues.caption_style = updates.captionStyle;

  const [row] = await db
    .update(projects)
    .set(setValues)
    .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)))
    .returning();
  return row ?? null;
}

// Verifies ownership, deletes all child rows then the project row, and best-effort deletes every
// owned R2 object under projects/{projectId}/. Returns false if not owned.
export async function deleteProject(projectId: string, userId: string): Promise<boolean> {
  const [projectRow] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)));
  if (!projectRow) return false;

  const [clipRows, audioRows, cueRows] = await Promise.all([
    db.select({ r2_key: projectClips.r2_key }).from(projectClips).where(eq(projectClips.project_id, projectId)),
    db
      .select({ r2_key: projectAudioClips.r2_key })
      .from(projectAudioClips)
      .where(eq(projectAudioClips.project_id, projectId)),
    db.select({ id: projectCaptionCues.id }).from(projectCaptionCues).where(eq(projectCaptionCues.project_id, projectId)),
  ]);
  const cueIds = cueRows.map((c) => c.id);

  if (cueIds.length > 0) {
    await db.delete(projectCaptionWords).where(inArray(projectCaptionWords.cue_id, cueIds));
  }
  await db.delete(projectCaptionCues).where(eq(projectCaptionCues.project_id, projectId));
  await db.delete(projectAudioClips).where(eq(projectAudioClips.project_id, projectId));
  await db.delete(projectTextOverlays).where(eq(projectTextOverlays.project_id, projectId));
  await db.delete(projectClips).where(eq(projectClips.project_id, projectId));
  await db.delete(projects).where(eq(projects.id, projectId));

  const allKeys = [
    ...clipRows.map((c) => c.r2_key),
    ...audioRows.map((a) => a.r2_key),
    ...(projectRow.thumbnail_r2_key ? [projectRow.thumbnail_r2_key] : []),
  ];
  for (const key of allKeys) {
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    } catch (err) {
      console.error('[projectService] Best-effort delete of project R2 object failed:', err);
    }
  }

  return true;
}

// ─── Cover (Plan 13-21 B3 — custom project thumbnail from a scrubbed frame) ────
// Returns null for "not found" in EITHER sense (project not owned, or clip not found/not owned/
// soft-deleted) — the route maps both to a single 404, matching every other IDOR-guarded lookup
// in this file. Video clips reuse the existing extractVideoFrame ffmpeg helper (the same one the
// auto-cover-on-first-import path already calls); image clips get a fresh independent CopyObject
// (never share the clip's own r2_key as the thumbnail — an R2 delete of one must never affect the
// other, same D-03 copy-not-reference rationale as clip import).
export async function setProjectCover(
  projectId: string,
  userId: string,
  clipId: string,
  atSeconds: number,
): Promise<{ thumbnailUrl: string } | null> {
  const [projectRow] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)));
  if (!projectRow) return null;

  const [clip] = await db
    .select()
    .from(projectClips)
    .where(and(eq(projectClips.id, clipId), eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)));
  if (!clip) return null;

  const duration = clip.original_duration_seconds;
  const clampedSeconds = duration != null ? Math.min(Math.max(atSeconds, 0), duration) : Math.max(atSeconds, 0);

  let newThumbnailKey: string;
  if (clip.media_type === 'image') {
    const ext = clip.r2_key.split('.').pop() ?? 'jpg';
    newThumbnailKey = `generations/project-cover-${randomUUID()}.${ext}`;
    await r2.send(
      new CopyObjectCommand({
        Bucket: R2_BUCKET,
        CopySource: `${R2_BUCKET}/${clip.r2_key}`,
        Key: newThumbnailKey,
      }),
    );
  } else {
    const clipUrl = await getUploadPresignedUrl(clip.r2_key);
    newThumbnailKey = await extractVideoFrame(clipUrl, `project-cover-${randomUUID()}`, clampedSeconds);
  }

  const oldThumbnailKey = projectRow.thumbnail_r2_key;
  await db
    .update(projects)
    .set({ thumbnail_r2_key: newThumbnailKey, updated_at: new Date() })
    .where(eq(projects.id, projectId));

  if (oldThumbnailKey && oldThumbnailKey !== newThumbnailKey) {
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: oldThumbnailKey }));
    } catch (err) {
      console.error('[projectService] Best-effort delete of old cover thumbnail failed:', err);
    }
  }

  const thumbnailUrl = await getUploadPresignedUrl(newThumbnailKey);
  return { thumbnailUrl };
}

// Plan 13-24 K-B1: accept a client-composited cover image (multipart upload). Stores under
// projects/{id}/cover/ so cover art is independently owned from clip media. Same IDOR null→404
// contract and best-effort old-thumbnail cleanup as setProjectCover.
export async function setProjectCoverFromUpload(
  projectId: string,
  userId: string,
  buffer: Buffer,
  contentType: string,
  ext: string,
): Promise<{ thumbnailUrl: string } | null> {
  const [projectRow] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)));
  if (!projectRow) return null;

  const newThumbnailKey = `projects/${projectId}/cover/${randomUUID()}.${ext}`;
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: newThumbnailKey,
      Body: buffer,
      ContentType: contentType,
    }),
  );

  const oldThumbnailKey = projectRow.thumbnail_r2_key;
  await db
    .update(projects)
    .set({ thumbnail_r2_key: newThumbnailKey, updated_at: new Date() })
    .where(eq(projects.id, projectId));

  if (oldThumbnailKey && oldThumbnailKey !== newThumbnailKey) {
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: oldThumbnailKey }));
    } catch (err) {
      console.error('[projectService] Best-effort delete of old cover thumbnail failed:', err);
    }
  }

  const thumbnailUrl = await getUploadPresignedUrl(newThumbnailKey);
  return { thumbnailUrl };
}

// ─── Import-by-copy (D-03) ─────────────────────────────────────────────────────

export interface ImportClipParams {
  projectId: string;
  userId: string;
  sourceType: 'generation' | 'upload';
  sourceId?: string; // generation id — required when sourceType === 'generation'
  uploadedR2Key?: string; // key the route already wrote to projects/{id}/clips/ — required when sourceType === 'upload'
  mimeType: string;
  mediaType: 'video' | 'image';
  durationSeconds?: number;
  width?: number;
  height?: number;
}

// Copy-not-reference (D-03): for 'generation' sources this resolves the source generation
// SCOPED BY user_id (ownership — REQUIRED, mirrors uploads.ts's /from-generation, T-13-08) before
// issuing a server-side R2-to-R2 copy. For 'upload' sources the file was already written directly
// to projects/{id}/clips/ by the route (a fresh upload has no prior owner to protect against).
export async function importClipByCopy(input: ImportClipParams): Promise<ProjectClip> {
  const { projectId, userId, sourceType, sourceId, uploadedR2Key, mediaType, mimeType } = input;
  let { durationSeconds, width, height } = input;

  let r2Key: string;

  if (sourceType === 'generation') {
    if (!sourceId) throw new Error('sourceId (generation_id) is required for sourceType=generation');
    const [gen] = await db
      .select({ r2_key: generations.r2_key, status: generations.status })
      .from(generations)
      .where(and(eq(generations.id, sourceId), eq(generations.user_id, userId)));
    if (!gen || gen.status !== 'completed' || !gen.r2_key) {
      throw new ImportSourceNotFoundError('Source generation not found, not owned, or not completed');
    }
    const ext = gen.r2_key.split('.').pop() ?? 'mp4';
    const destKey = `projects/${projectId}/clips/${randomUUID()}.${ext}`;
    await r2.send(
      new CopyObjectCommand({
        Bucket: R2_BUCKET,
        CopySource: `${R2_BUCKET}/${gen.r2_key}`,
        Key: destKey,
        ContentType: mimeType,
      }),
    );
    r2Key = destKey;

    // B1 (Plan 13-20, extended by Plan 13-22 B1): derive a real duration + pixel dimensions at
    // import time. Images get a fixed CapCut-style still duration but are still probed for
    // dimensions (ffprobe reads image pixel size too). Videos are probed against a fresh presigned
    // GET of the just-copied R2 object (same presign helper getProjectWithState uses for clip
    // `url`s). Probe failure must never fail the import — durationSeconds/width/height stay
    // whatever the caller passed (usually undefined), persisted as null, self-healed later by
    // getProjectWithState.
    const presignedUrl = await getUploadPresignedUrl(destKey);
    const meta = await probeVideoMeta(presignedUrl);
    width = meta.width ?? undefined;
    height = meta.height ?? undefined;
    if (mediaType === 'image') {
      durationSeconds = 3;
    } else if (meta.durationSeconds !== null) {
      durationSeconds = meta.durationSeconds;
    }
  } else {
    if (!uploadedR2Key) throw new Error('uploadedR2Key is required for sourceType=upload');
    r2Key = uploadedR2Key;
  }

  const nextOrderResult = await db.execute(sql`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM project_clips
    WHERE project_id = ${projectId}::uuid AND deleted_at IS NULL
  `);
  const nextSortOrder = Number((nextOrderResult.rows?.[0] as { next_order?: number } | undefined)?.next_order ?? 0);

  const [clip] = await db
    .insert(projectClips)
    .values({
      project_id: projectId,
      sort_order: nextSortOrder,
      r2_key: r2Key,
      media_type: mediaType,
      source_type: sourceType,
      original_duration_seconds: durationSeconds ?? null,
      width: width ?? null,
      height: height ?? null,
    })
    .returning();

  // First clip ever added to this project (nextSortOrder === 0) becomes its cover thumbnail.
  // Await the best-effort work before returning so the create-project flow's immediate follow-up
  // GET cannot race the thumbnail update and permanently cache a nil cover. Video clips get a
  // real extracted frame
  // (reuses AI Influencer Pro's frameExtractor.ts, same execFile-fixed-argv ffmpeg pattern);
  // image clips are already a still, so their own r2Key is the thumbnail directly. Does not
  // re-derive on every subsequent clip add/delete — the project's cover is set once, like a
  // static poster, not a live "current first clip" mirror. A cover failure still never fails the
  // clip import; it is logged and the project remains editable.
  if (nextSortOrder === 0) {
    try {
      await setProjectThumbnailFromClip(projectId, r2Key, mediaType);
    } catch (err) {
      console.error('[projectService] setProjectThumbnailFromClip failed (non-blocking):', err);
    }
  }

  return clip;
}

async function setProjectThumbnailFromClip(
  projectId: string,
  clipR2Key: string,
  mediaType: 'video' | 'image',
): Promise<void> {
  let thumbnailR2Key: string;
  if (mediaType === 'image') {
    thumbnailR2Key = clipR2Key;
  } else {
    const clipUrl = await getUploadPresignedUrl(clipR2Key);
    thumbnailR2Key = await extractVideoFrame(clipUrl, `project-thumb-${randomUUID()}`);
  }
  await db.update(projects).set({ thumbnail_r2_key: thumbnailR2Key }).where(eq(projects.id, projectId));
}

// ─── Clip split (T-13-19 Task G1) ──────────────────────────────────────────────
// Copy-then-insert, mirroring importClipByCopy: never shares one r2_key across two rows
// (deleteClip's DELETE route deletes the R2 object, so each split piece must own an independent
// copy). The caller (route) is responsible for the MAX_CLIPS_PER_PROJECT cap check BEFORE calling
// this, matching the existing POST /:id/clips convention (cap-check-then-mutate at the route
// layer). project_clips.trim_start_seconds/trim_end_seconds are INTEGER columns (existing schema
// constraint, unchanged here) — callers must pass whole seconds.

export interface SplitClipInput {
  /** Where to cut, in the clip's own trim-seconds space. Must be strictly inside (trim_start, currentTrimEnd). */
  originalTrimEnd: number;
  newTrimStart: number;
  newTrimEnd: number;
  newSortOrder: number;
}

export async function splitClip(
  projectId: string,
  userId: string,
  clipId: string,
  input: SplitClipInput,
): Promise<{ originalClip: ProjectClip; newClip: ProjectClip } | null> {
  if (!(await isProjectOwned(projectId, userId))) return null;

  const [clip] = await db
    .select()
    .from(projectClips)
    .where(
      and(eq(projectClips.id, clipId), eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)),
    );
  if (!clip) return null;

  const currentTrimEnd = clip.trim_end_seconds ?? clip.original_duration_seconds;
  if (currentTrimEnd == null) {
    throw new SplitValidationError('Clip has no resolvable trim_end_seconds — set trim points before splitting');
  }
  if (input.originalTrimEnd <= clip.trim_start_seconds || input.originalTrimEnd >= currentTrimEnd) {
    throw new SplitValidationError('Split point must be strictly inside the clip\'s current trim range');
  }
  if (input.newTrimStart >= input.newTrimEnd) {
    throw new SplitValidationError('new_trim_start must be less than new_trim_end');
  }

  const ext = clip.r2_key.split('.').pop() ?? 'mp4';
  const destKey = `projects/${projectId}/clips/${randomUUID()}.${ext}`;
  await r2.send(
    new CopyObjectCommand({
      Bucket: R2_BUCKET,
      CopySource: `${R2_BUCKET}/${clip.r2_key}`,
      Key: destKey,
    }),
  );

  // Resequence: every OTHER clip at/after the new piece's slot shifts down one — same contract
  // updateClip(sortOrder:) already relies on (sort_order is a dense 0..N-1 ordering). Soft-deleted
  // rows are excluded (B1) — a deleted clip's stale sort_order shouldn't shift on live edits.
  await db.execute(sql`
    UPDATE project_clips SET sort_order = sort_order + 1
    WHERE project_id = ${projectId}::uuid AND sort_order >= ${input.newSortOrder} AND id != ${clipId}::uuid
      AND deleted_at IS NULL
  `);

  const [newClip] = await db
    .insert(projectClips)
    .values({
      project_id: projectId,
      sort_order: input.newSortOrder,
      r2_key: destKey,
      media_type: clip.media_type,
      source_type: clip.source_type,
      original_duration_seconds: clip.original_duration_seconds,
      // Same source pixels, just a duration trim — carry the already-known dimensions through
      // rather than leaving them null (would otherwise re-trigger a probe on next read).
      width: clip.width,
      height: clip.height,
      trim_start_seconds: input.newTrimStart,
      trim_end_seconds: input.newTrimEnd,
      volume: clip.volume,
    })
    .returning();

  const [updatedOriginal] = await db
    .update(projectClips)
    .set({ trim_end_seconds: input.originalTrimEnd })
    .where(eq(projectClips.id, clipId))
    .returning();

  return { originalClip: updatedOriginal, newClip };
}

// ─── Clip soft-delete / restore (Plan 13-21 B1 — full undo of deletes) ─────────
// Mirrors deleteAudioClip/restoreAudioClip's shape exactly. The R2 object is kept until
// purgeExpiredSoftDeletes reaps it 24h later — undo just clears deleted_at, no re-copy needed.

export async function softDeleteClip(projectId: string, userId: string, clipId: string): Promise<boolean> {
  if (!(await isProjectOwned(projectId, userId))) return false;

  const [row] = await db
    .update(projectClips)
    .set({ deleted_at: new Date() })
    .where(and(eq(projectClips.id, clipId), eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)))
    .returning({ id: projectClips.id });
  return !!row;
}

export async function restoreClip(projectId: string, userId: string, clipId: string): Promise<ProjectClip | null> {
  if (!(await isProjectOwned(projectId, userId))) return null;

  const [row] = await db
    .update(projectClips)
    .set({ deleted_at: null })
    .where(
      and(eq(projectClips.id, clipId), eq(projectClips.project_id, projectId), isNotNull(projectClips.deleted_at)),
    )
    .returning();
  return row ?? null;
}

// ─── Text overlay CRUD (SC3) ───────────────────────────────────────────────────
// Bounds validation (x_norm/y_norm ∈ [0,1], width_norm ∈ [0.5,3], T-13-44) happens at the ROUTE
// layer BEFORE calling these — mirrors updateProject's validation split (route validates,
// service assumes pre-validated input and focuses on ownership + persistence).

export interface AddTextOverlayInput {
  text: string;
  xNorm: number;
  yNorm: number;
  widthNorm?: number;
  rotation?: number;
  rowIndex?: number;
  startSeconds: number;
  endSeconds: number;
}
export interface UpdateTextOverlayInput {
  text?: string;
  xNorm?: number;
  yNorm?: number;
  widthNorm?: number;
  rotation?: number;
  rowIndex?: number;
  startSeconds?: number;
  endSeconds?: number;
}

export async function addTextOverlay(
  projectId: string,
  userId: string,
  input: AddTextOverlayInput,
): Promise<ProjectTextOverlay | null> {
  if (!(await isProjectOwned(projectId, userId))) return null;

  const [row] = await db
    .insert(projectTextOverlays)
    .values({
      project_id: projectId,
      text: input.text,
      x_norm: input.xNorm,
      y_norm: input.yNorm,
      width_norm: input.widthNorm ?? null,
      rotation: input.rotation ?? 0,
      row_index: input.rowIndex ?? null,
      start_seconds: input.startSeconds,
      end_seconds: input.endSeconds,
    })
    .returning();
  return row;
}

export async function updateTextOverlay(
  projectId: string,
  userId: string,
  textId: string,
  updates: UpdateTextOverlayInput,
): Promise<ProjectTextOverlay | null> {
  if (!(await isProjectOwned(projectId, userId))) return null;

  const setValues: Record<string, unknown> = {};
  if (updates.text !== undefined) setValues.text = updates.text;
  if (updates.xNorm !== undefined) setValues.x_norm = updates.xNorm;
  if (updates.yNorm !== undefined) setValues.y_norm = updates.yNorm;
  if (updates.widthNorm !== undefined) setValues.width_norm = updates.widthNorm;
  if (updates.rotation !== undefined) setValues.rotation = updates.rotation;
  if (updates.rowIndex !== undefined) setValues.row_index = updates.rowIndex;
  if (updates.startSeconds !== undefined) setValues.start_seconds = updates.startSeconds;
  if (updates.endSeconds !== undefined) setValues.end_seconds = updates.endSeconds;

  const [row] = await db
    .update(projectTextOverlays)
    .set(setValues)
    .where(and(eq(projectTextOverlays.id, textId), eq(projectTextOverlays.project_id, projectId)))
    .returning();
  return row ?? null;
}

export async function deleteTextOverlay(projectId: string, userId: string, textId: string): Promise<boolean> {
  if (!(await isProjectOwned(projectId, userId))) return false;

  const [row] = await db
    .delete(projectTextOverlays)
    .where(and(eq(projectTextOverlays.id, textId), eq(projectTextOverlays.project_id, projectId)))
    .returning({ id: projectTextOverlays.id });
  return !!row;
}

// ─── Audio clip CRUD (SC4 — multi-clip Audio track, UI-SPEC Resolved Q1) ───────

export interface AddAudioClipInput {
  r2Key: string;
  sourceType: 'upload' | 'preset';
  startOffsetSeconds?: number;
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  originalDurationSeconds?: number | null;
}
export interface UpdateAudioClipInput {
  startOffsetSeconds?: number;
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  sortOrder?: number;
}

export async function addAudioClip(
  projectId: string,
  userId: string,
  input: AddAudioClipInput,
): Promise<ProjectAudioClip | null> {
  if (!(await isProjectOwned(projectId, userId))) return null;

  const nextOrderResult = await db.execute(sql`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM project_audio_clips
    WHERE project_id = ${projectId}::uuid AND deleted_at IS NULL
  `);
  const nextSortOrder = Number((nextOrderResult.rows?.[0] as { next_order?: number } | undefined)?.next_order ?? 0);

  const [row] = await db
    .insert(projectAudioClips)
    .values({
      project_id: projectId,
      r2_key: input.r2Key,
      source_type: input.sourceType,
      start_offset_seconds: input.startOffsetSeconds ?? 0,
      trim_start_seconds: input.trimStartSeconds ?? 0,
      trim_end_seconds: input.trimEndSeconds ?? null,
      original_duration_seconds: input.originalDurationSeconds ?? null,
      sort_order: nextSortOrder,
    })
    .returning();
  return row;
}

export async function updateAudioClip(
  projectId: string,
  userId: string,
  audioId: string,
  updates: UpdateAudioClipInput,
): Promise<ProjectAudioClip | null> {
  if (!(await isProjectOwned(projectId, userId))) return null;

  const setValues: Record<string, unknown> = {};
  if (updates.startOffsetSeconds !== undefined) setValues.start_offset_seconds = updates.startOffsetSeconds;
  if (updates.trimStartSeconds !== undefined) setValues.trim_start_seconds = updates.trimStartSeconds;
  if (updates.trimEndSeconds !== undefined) setValues.trim_end_seconds = updates.trimEndSeconds;
  if (updates.sortOrder !== undefined) setValues.sort_order = updates.sortOrder;

  const [row] = await db
    .update(projectAudioClips)
    .set(setValues)
    .where(
      and(
        eq(projectAudioClips.id, audioId),
        eq(projectAudioClips.project_id, projectId),
        isNull(projectAudioClips.deleted_at),
      ),
    )
    .returning();
  return row ?? null;
}

// B1: soft-delete only — sets deleted_at, keeps the row AND its R2 object so undo can fully
// restore it via restoreAudioClip. The R2 object is reaped later by purgeExpiredSoftDeletes.
export async function deleteAudioClip(projectId: string, userId: string, audioId: string): Promise<boolean> {
  if (!(await isProjectOwned(projectId, userId))) return false;

  const [row] = await db
    .update(projectAudioClips)
    .set({ deleted_at: new Date() })
    .where(
      and(
        eq(projectAudioClips.id, audioId),
        eq(projectAudioClips.project_id, projectId),
        isNull(projectAudioClips.deleted_at),
      ),
    )
    .returning({ id: projectAudioClips.id });
  return !!row;
}

// B1.3: restore endpoint target — clears deleted_at. Returns null (route maps to 404) if the row
// doesn't exist, isn't owned, was never deleted, or was already purged past the 24h window.
export async function restoreAudioClip(
  projectId: string,
  userId: string,
  audioId: string,
): Promise<ProjectAudioClip | null> {
  if (!(await isProjectOwned(projectId, userId))) return null;

  const [row] = await db
    .update(projectAudioClips)
    .set({ deleted_at: null })
    .where(
      and(
        eq(projectAudioClips.id, audioId),
        eq(projectAudioClips.project_id, projectId),
        isNotNull(projectAudioClips.deleted_at),
      ),
    )
    .returning();
  return row ?? null;
}

// ─── Audio clip split (T-13-19 Task G2) ────────────────────────────────────────
// Same copy-then-insert shape as splitClip. Unlike clips, audio pills aren't a dense
// position-ordered sequence (start_offset_seconds — not sort_order — drives timeline position),
// so the new piece is simply appended at the next sort_order (same convention addAudioClip uses),
// no resequencing needed.

export interface SplitAudioClipInput {
  /** Where to cut, in the audio clip's own trim-seconds space. Must be strictly inside (trim_start, currentTrimEnd). */
  originalTrimEnd: number;
  newTrimStart: number;
  newTrimEnd: number;
  newStartOffsetSeconds: number;
}

export async function splitAudioClip(
  projectId: string,
  userId: string,
  audioId: string,
  input: SplitAudioClipInput,
): Promise<{ originalAudioClip: ProjectAudioClip; newAudioClip: ProjectAudioClip } | null> {
  if (!(await isProjectOwned(projectId, userId))) return null;

  const [audio] = await db
    .select()
    .from(projectAudioClips)
    .where(
      and(
        eq(projectAudioClips.id, audioId),
        eq(projectAudioClips.project_id, projectId),
        isNull(projectAudioClips.deleted_at),
      ),
    );
  if (!audio) return null;

  // B2 fix (Plan 13-21 F9.1's backend counterpart): fall back to the probed
  // original_duration_seconds for never-explicitly-trimmed audio, mirroring splitClip's identical
  // clip.trim_end_seconds ?? clip.original_duration_seconds guard above — previously this bailed
  // on ANY untrimmed audio clip (the root cause of "audio split silently does nothing").
  const currentTrimEnd = audio.trim_end_seconds ?? audio.original_duration_seconds;
  if (currentTrimEnd == null) {
    throw new SplitValidationError('Audio clip has no trim_end_seconds set — set trim points before splitting');
  }
  if (input.originalTrimEnd <= audio.trim_start_seconds || input.originalTrimEnd >= currentTrimEnd) {
    throw new SplitValidationError('Split point must be strictly inside the audio clip\'s current trim range');
  }
  if (input.newTrimStart >= input.newTrimEnd) {
    throw new SplitValidationError('new_trim_start must be less than new_trim_end');
  }

  const ext = audio.r2_key.split('.').pop() ?? 'm4a';
  const destKey = `projects/${projectId}/audio/${randomUUID()}.${ext}`;
  await r2.send(
    new CopyObjectCommand({
      Bucket: R2_BUCKET,
      CopySource: `${R2_BUCKET}/${audio.r2_key}`,
      Key: destKey,
    }),
  );

  const nextOrderResult = await db.execute(sql`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM project_audio_clips
    WHERE project_id = ${projectId}::uuid AND deleted_at IS NULL
  `);
  const nextSortOrder = Number((nextOrderResult.rows?.[0] as { next_order?: number } | undefined)?.next_order ?? 0);

  const [newAudioClip] = await db
    .insert(projectAudioClips)
    .values({
      project_id: projectId,
      r2_key: destKey,
      source_type: audio.source_type,
      start_offset_seconds: input.newStartOffsetSeconds,
      trim_start_seconds: input.newTrimStart,
      trim_end_seconds: input.newTrimEnd,
      original_duration_seconds: audio.original_duration_seconds,
      sort_order: nextSortOrder,
    })
    .returning();

  const [updatedOriginal] = await db
    .update(projectAudioClips)
    .set({ trim_end_seconds: input.originalTrimEnd })
    .where(eq(projectAudioClips.id, audioId))
    .returning();

  return { originalAudioClip: updatedOriginal, newAudioClip };
}

// ─── Caption cue/word CRUD (SC5, D-13) ─────────────────────────────────────────
// A "cue" is a displayed line/phrase; each cue owns N words shaped {text, start, end} — the
// exact shape Phase 14's AI Autoexplainer smart-unpack (D-15/D-16) already writes into directly.

export interface CaptionWordInput {
  text: string;
  startSeconds: number;
  endSeconds: number;
}
export interface AddCaptionCueInput {
  startSeconds: number;
  endSeconds: number;
  words?: CaptionWordInput[];
}

export interface CaptionTimelineClip {
  id: string;
  trimStartSeconds: number;
  trimEndSeconds: number | null;
  originalDurationSeconds: number | null;
}

interface NormalizedClipWindow {
  start: number;
  end: number;
}

function normalizeCaptionClipWindow(clip: CaptionTimelineClip): NormalizedClipWindow | null {
  if (!Number.isFinite(clip.trimStartSeconds)) return null;
  if (
    clip.originalDurationSeconds !== null &&
    (!Number.isFinite(clip.originalDurationSeconds) || clip.originalDurationSeconds < 0)
  ) {
    return null;
  }

  const sourceDuration = clip.originalDurationSeconds;
  const clampToSource = (value: number): number => {
    const nonNegative = Math.max(0, value);
    return sourceDuration === null ? nonNegative : Math.min(nonNegative, sourceDuration);
  };
  const start = clampToSource(clip.trimStartSeconds);
  const rawEnd = clip.trimEndSeconds ?? sourceDuration ?? start;
  if (!Number.isFinite(rawEnd)) return null;
  return { start, end: clampToSource(rawEnd) };
}

/**
 * Converts Whisper's source-local word times into the project's global timeline. The target
 * clip's current position is derived from the authoritative, already-reordered clip rows. Words
 * outside its visible trim window are removed; boundary-crossing words are clipped so captions
 * can never spill into an adjacent clip.
 */
export function translateCaptionDraftsToProjectTimeline(
  drafts: AddCaptionCueInput[],
  orderedClips: CaptionTimelineClip[],
  targetClipId: string,
): AddCaptionCueInput[] {
  const targetIndex = orderedClips.findIndex((clip) => clip.id === targetClipId);
  if (targetIndex < 0) return [];

  const visibleDuration = (clip: CaptionTimelineClip): number => {
    const window = normalizeCaptionClipWindow(clip);
    if (!window) return 0;
    const duration = Math.max(0, window.end - window.start);
    return Number.isFinite(duration) ? duration : 0;
  };
  let timelineStart = 0;
  for (const clip of orderedClips.slice(0, targetIndex)) {
    const next = timelineStart + visibleDuration(clip);
    if (!Number.isFinite(next)) return [];
    timelineStart = next;
  }
  const target = orderedClips[targetIndex];
  const targetWindow = normalizeCaptionClipWindow(target);
  if (!targetWindow || targetWindow.end <= targetWindow.start) return [];
  const visibleSourceStart = targetWindow.start;
  const visibleSourceEnd = targetWindow.end;

  const translated: AddCaptionCueInput[] = [];
  for (const draft of drafts) {
    const words: CaptionWordInput[] = [];
    for (const word of draft.words ?? []) {
      if (!Number.isFinite(word.startSeconds) || !Number.isFinite(word.endSeconds)) continue;
      const clippedStart = Math.max(word.startSeconds, visibleSourceStart);
      const clippedEnd = Math.min(word.endSeconds, visibleSourceEnd);
      if (clippedEnd <= clippedStart) continue;
      const mappedStart = Math.max(0, clippedStart - visibleSourceStart + timelineStart);
      const mappedEnd = Math.max(0, clippedEnd - visibleSourceStart + timelineStart);
      if (!Number.isFinite(mappedStart) || !Number.isFinite(mappedEnd)) continue;
      if (mappedEnd <= mappedStart) continue;
      words.push({
        text: word.text,
        startSeconds: mappedStart,
        endSeconds: mappedEnd,
      });
    }
    if (words.length === 0) continue;
    translated.push({
      startSeconds: Math.min(...words.map((word) => word.startSeconds)),
      endSeconds: Math.max(...words.map((word) => word.endSeconds)),
      words,
    });
  }
  return translated;
}
export interface UpdateCaptionCueInput {
  startSeconds?: number;
  endSeconds?: number;
  words?: CaptionWordInput[]; // presence REPLACES the cue's entire word list (tap-to-edit path)
}

export async function addCaptionCue(
  projectId: string,
  userId: string,
  input: AddCaptionCueInput,
): Promise<ProjectCaptionCueWithWords | null> {
  if (!(await isProjectOwned(projectId, userId))) return null;

  const nextOrderResult = await db.execute(sql`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM project_caption_cues WHERE project_id = ${projectId}::uuid
  `);
  const nextSortOrder = Number((nextOrderResult.rows?.[0] as { next_order?: number } | undefined)?.next_order ?? 0);

  const [cueRow] = await db
    .insert(projectCaptionCues)
    .values({
      project_id: projectId,
      sort_order: nextSortOrder,
      start_seconds: input.startSeconds,
      end_seconds: input.endSeconds,
    })
    .returning();

  let words: ProjectCaptionWord[] = [];
  if (cueRow && input.words && input.words.length > 0) {
    words = await db
      .insert(projectCaptionWords)
      .values(
        input.words.map((w, i) => ({
          cue_id: cueRow.id,
          text: w.text,
          start_seconds: w.startSeconds,
          end_seconds: w.endSeconds,
          sort_order: i,
        })),
      )
      .returning();
  }

  return { ...cueRow, words };
}

// Retimes the cue and/or replaces its word list — replaces (delete-then-insert), never a
// per-word PATCH, matching the tap-to-edit interaction model from 13-UI-SPEC.md.
export async function updateCaptionCue(
  projectId: string,
  userId: string,
  cueId: string,
  updates: UpdateCaptionCueInput,
): Promise<ProjectCaptionCueWithWords | null> {
  if (!(await isProjectOwned(projectId, userId))) return null;

  const [existing] = await db
    .select()
    .from(projectCaptionCues)
    .where(and(eq(projectCaptionCues.id, cueId), eq(projectCaptionCues.project_id, projectId)));
  if (!existing) return null;

  let cueRow: ProjectCaptionCue = existing;
  const setValues: Record<string, unknown> = {};
  if (updates.startSeconds !== undefined) setValues.start_seconds = updates.startSeconds;
  if (updates.endSeconds !== undefined) setValues.end_seconds = updates.endSeconds;
  if (Object.keys(setValues).length > 0) {
    const [updated] = await db
      .update(projectCaptionCues)
      .set(setValues)
      .where(eq(projectCaptionCues.id, cueId))
      .returning();
    if (updated) cueRow = updated;
  }

  let words: ProjectCaptionWord[];
  if (updates.words !== undefined) {
    await db.delete(projectCaptionWords).where(eq(projectCaptionWords.cue_id, cueId));
    words =
      updates.words.length > 0
        ? await db
            .insert(projectCaptionWords)
            .values(
              updates.words.map((w, i) => ({
                cue_id: cueId,
                text: w.text,
                start_seconds: w.startSeconds,
                end_seconds: w.endSeconds,
                sort_order: i,
              })),
            )
            .returning()
        : [];
  } else {
    words = await db
      .select()
      .from(projectCaptionWords)
      .where(eq(projectCaptionWords.cue_id, cueId))
      .orderBy(projectCaptionWords.sort_order);
  }

  return { ...cueRow, words };
}

export async function deleteCaptionCue(projectId: string, userId: string, cueId: string): Promise<boolean> {
  if (!(await isProjectOwned(projectId, userId))) return false;

  const [existing] = await db
    .select({ id: projectCaptionCues.id })
    .from(projectCaptionCues)
    .where(and(eq(projectCaptionCues.id, cueId), eq(projectCaptionCues.project_id, projectId)));
  if (!existing) return false;

  await db.delete(projectCaptionWords).where(eq(projectCaptionWords.cue_id, cueId));
  await db.delete(projectCaptionCues).where(eq(projectCaptionCues.id, cueId));
  return true;
}

// Bulk clear (D-13) — one call wipes every caption cue + word for the project, not per-line.
export async function deleteAllCaptions(projectId: string, userId: string): Promise<boolean> {
  if (!(await isProjectOwned(projectId, userId))) return false;

  const cueRows = await db
    .select({ id: projectCaptionCues.id })
    .from(projectCaptionCues)
    .where(eq(projectCaptionCues.project_id, projectId));
  const cueIds = cueRows.map((c) => c.id);

  if (cueIds.length > 0) {
    await db.delete(projectCaptionWords).where(inArray(projectCaptionWords.cue_id, cueIds));
  }
  await db.delete(projectCaptionCues).where(eq(projectCaptionCues.project_id, projectId));
  return true;
}

// ─── Smart unpack on import (D-15/D-16, generalized per Claude's Discretion) ───

export interface StructuredAudioStem {
  r2Key: string;
  sourceType: 'narration' | 'preset' | 'upload';
  startOffsetSeconds?: number;
  trimStartSeconds?: number;
  trimEndSeconds?: number;
}
export interface StructuredCaptionWord {
  text: string;
  startSeconds: number;
  endSeconds: number;
}
export interface StructuredCaptionCue {
  startSeconds: number;
  endSeconds: number;
  words: StructuredCaptionWord[];
}
// A timeline video clip = a trim window into an original source (the user's uploaded footage),
// NOT a pre-rendered file. On import each becomes its own independent copy of the source + a
// projectClips row carrying the trim window — mirroring importClipByCopy's copy-per-row invariant
// (purgeExpiredSoftDeletes deletes a soft-deleted clip's r2_key with no refcount, so N clips must
// never share one object).
export interface StructuredVideoClip {
  sourceR2Key: string;
  trimStartSeconds: number;
  trimEndSeconds: number;
  outputDurationSeconds?: number;
  // Linear gain for THIS clip's own source-footage audio on the rebuilt timeline (0 = muted).
  // The producer declares the intended mix: the Video Summarizer emits 0 because its burned master
  // drops footage audio entirely (buildSummaryComposeArgs maps only narration+music), so an
  // imported recap must start footage-silent to match — the narration stem carries the voice, and
  // the user can raise footage audio in the editor. Absent → 1 (full), the general import default.
  sourceVolume?: number;
}
export interface StructuredImportData {
  captionCues?: StructuredCaptionCue[];
  audioStems?: StructuredAudioStem[];
  videoClips?: StructuredVideoClip[];
}

// GENERALIZED mechanism (not autoexplainer-specific): if the source generation's params.structured
// marker carries captionCues and/or audioStems, unpack them directly into project_audio_clips /
// project_caption_cues+words instead of the caller importing one opaque clip. No marker → no-op,
// normal single-clip import proceeds unaffected. This is Phase 14's stable write target (D-15/D-16) —
// the {text, start, end}-per-word shape matches the AI Autoexplainer pipeline design note verbatim.
export async function smartUnpackOnImport(
  projectId: string,
  sourceGeneration: { id: string; params: unknown },
): Promise<{ unpacked: boolean; clips: ProjectClip[] }> {
  const params = (sourceGeneration.params ?? null) as Record<string, unknown> | null;
  const structured = params?.structured as StructuredImportData | undefined;
  const audioStems = structured?.audioStems ?? [];
  const captionCues = structured?.captionCues ?? [];
  const videoClips = structured?.videoClips ?? [];

  if (!structured || (audioStems.length === 0 && captionCues.length === 0 && videoClips.length === 0)) {
    return { unpacked: false, clips: [] };
  }

  // Rebuild the editable video timeline from the source's trim windows. Each clip gets its own
  // independent copy of the source (see StructuredVideoClip note + purge refcount hazard). The
  // source video is identical across every clip, so probe its dimensions/duration ONCE and reuse.
  const rebuiltClips: ProjectClip[] = [];
  if (videoClips.length > 0) {
    const baseOrderResult = await db.execute(sql`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM project_clips
      WHERE project_id = ${projectId}::uuid AND deleted_at IS NULL
    `);
    const baseOrder = Number((baseOrderResult.rows?.[0] as { next_order?: number } | undefined)?.next_order ?? 0);

    let sourceWidth: number | null = null;
    let sourceHeight: number | null = null;
    let sourceDuration: number | null = null;
    let probed = false;

    for (let i = 0; i < videoClips.length; i++) {
      const vc = videoClips[i];
      const ext = vc.sourceR2Key.split('.').pop() ?? 'mp4';
      const destKey = `projects/${projectId}/clips/${randomUUID()}.${ext}`;
      try {
        await r2.send(
          new CopyObjectCommand({
            Bucket: R2_BUCKET,
            CopySource: `${R2_BUCKET}/${vc.sourceR2Key}`,
            Key: destKey,
          }),
        );
      } catch (err) {
        throw new ImportSourceNotFoundError(
          `Source footage for this summary is no longer available (${vc.sourceR2Key})`,
        );
      }

      if (!probed) {
        // Probe failure must never fail the import — dimensions self-heal on read like a normal import.
        try {
          const meta = await probeVideoMeta(await getUploadPresignedUrl(destKey));
          sourceWidth = meta.width ?? null;
          sourceHeight = meta.height ?? null;
          sourceDuration = meta.durationSeconds ?? null;
        } catch (err) {
          console.error('[projectService] summary clip probe failed (non-blocking):', err);
        }
        probed = true;
      }

      const [clip] = await db
        .insert(projectClips)
        .values({
          project_id: projectId,
          sort_order: baseOrder + i,
          r2_key: destKey,
          media_type: 'video',
          source_type: 'generation',
          original_duration_seconds: sourceDuration,
          width: sourceWidth,
          height: sourceHeight,
          trim_start_seconds: vc.trimStartSeconds,
          trim_end_seconds: vc.trimEndSeconds,
          volume: Math.min(Math.max(vc.sourceVolume ?? 1, 0), 1),
        })
        .returning();
      if (clip) rebuiltClips.push(clip);

      // First clip in an empty project becomes its cover, mirroring importClipByCopy.
      if (baseOrder + i === 0) {
        try {
          await setProjectThumbnailFromClip(projectId, destKey, 'video');
        } catch (err) {
          console.error('[projectService] summary cover thumbnail failed (non-blocking):', err);
        }
      }
    }
  }

  for (let i = 0; i < audioStems.length; i++) {
    const stem = audioStems[i];
    const ext = stem.r2Key.split('.').pop() ?? 'mp3';
    const destKey = `projects/${projectId}/audio/${randomUUID()}.${ext}`;
    await r2.send(
      new CopyObjectCommand({
        Bucket: R2_BUCKET,
        CopySource: `${R2_BUCKET}/${stem.r2Key}`,
        Key: destKey,
      }),
    );
    await db.insert(projectAudioClips).values({
      project_id: projectId,
      r2_key: destKey,
      source_type: stem.sourceType,
      start_offset_seconds: stem.startOffsetSeconds ?? 0,
      trim_start_seconds: stem.trimStartSeconds ?? 0,
      trim_end_seconds: stem.trimEndSeconds ?? null,
      sort_order: i,
    });
  }

  for (let i = 0; i < captionCues.length; i++) {
    const cue = captionCues[i];
    const [cueRow] = await db
      .insert(projectCaptionCues)
      .values({
        project_id: projectId,
        sort_order: i,
        start_seconds: cue.startSeconds,
        end_seconds: cue.endSeconds,
      })
      .returning();
    if (cueRow && cue.words?.length > 0) {
      await db.insert(projectCaptionWords).values(
        cue.words.map((w, wi) => ({
          cue_id: cueRow.id,
          text: w.text,
          start_seconds: w.startSeconds,
          end_seconds: w.endSeconds,
          sort_order: wi,
        })),
      );
    }
  }

  return { unpacked: true, clips: rebuiltClips };
}

// ─── Export snapshot (SC7, D-10/D-12) ──────────────────────────────────────────
// Builds the FULL ComposeSpec from the project's CURRENT rows at export-REQUEST time
// (RESEARCH.md Pitfall 4) — the caller (POST /:id/export) passes the returned spec straight into
// the ffmpegQueue job payload; the compose worker NEVER re-reads project_* tables mid-render, so
// further edits to the (still-editable-per-D-12) project during/after export cannot corrupt an
// in-flight render. Uses RAW r2_key values (the worker downloads them directly via its own
// presigned-URL resolution) — deliberately NOT getUploadPresignedUrl, unlike getProjectWithState.

const DEFAULT_CAPTION_STYLE: ComposeCaptionStyle = {
  fontSize: 64,
  color: '#FFFFFF',
  highlightColor: '#8C59FF',
  position: 'bottom',
};

// IDOR guard: userId scoped in the project row lookup — returns null for a not-found/not-owned
// project (mirrors getProjectWithState). Throws ExportValidationError if any clip/audio clip
// lacks a resolvable trim_end_seconds — never silently coerces to 0, which would render a
// degenerate (zero-duration) export.
export async function buildComposeSnapshot(projectId: string, userId: string): Promise<ComposeSpec | null> {
  const [projectRow] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)));
  if (!projectRow) return null;

  const [clipRows, textRows, audioRows, cueRows] = await Promise.all([
    db
      .select()
      .from(projectClips)
      .where(and(eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)))
      .orderBy(projectClips.sort_order),
    db
      .select()
      .from(projectTextOverlays)
      .where(eq(projectTextOverlays.project_id, projectId))
      .orderBy(projectTextOverlays.start_seconds),
    db
      .select()
      .from(projectAudioClips)
      .where(and(eq(projectAudioClips.project_id, projectId), isNull(projectAudioClips.deleted_at)))
      .orderBy(projectAudioClips.sort_order),
    db
      .select()
      .from(projectCaptionCues)
      .where(eq(projectCaptionCues.project_id, projectId))
      .orderBy(projectCaptionCues.sort_order),
  ]);

  const cueIds = cueRows.map((c) => c.id);
  const wordRows =
    cueIds.length > 0
      ? await db
          .select()
          .from(projectCaptionWords)
          .where(inArray(projectCaptionWords.cue_id, cueIds))
          .orderBy(projectCaptionWords.sort_order)
      : [];
  const wordsByCue: Record<string, ProjectCaptionWord[]> = {};
  for (const w of wordRows) {
    (wordsByCue[w.cue_id] ??= []).push(w);
  }

  const clips = clipRows.map((c) => {
    const trimEndSeconds = c.trim_end_seconds ?? c.original_duration_seconds;
    if (trimEndSeconds == null) {
      throw new ExportValidationError(
        `Clip ${c.id} has no trim_end_seconds set — set trim points on every clip before exporting`,
      );
    }
    return {
      r2Key: c.r2_key,
      mediaType: c.media_type as 'video' | 'image',
      trimStartSeconds: c.trim_start_seconds,
      trimEndSeconds,
      volume: c.volume,
    };
  });

  const audioClips = audioRows.map((a) => {
    if (a.trim_end_seconds == null) {
      throw new ExportValidationError(
        `Audio clip ${a.id} has no trim_end_seconds set — set trim points on every audio clip before exporting`,
      );
    }
    return {
      r2Key: a.r2_key,
      startOffsetSeconds: a.start_offset_seconds,
      trimStartSeconds: a.trim_start_seconds,
      trimEndSeconds: a.trim_end_seconds,
    };
  });

  const captionCues: ComposeCaptionCue[] = cueRows.map((cue) => ({
    startSeconds: cue.start_seconds,
    endSeconds: cue.end_seconds,
    words: (wordsByCue[cue.id] ?? []).map((w) => ({
      text: w.text,
      startSeconds: w.start_seconds,
      endSeconds: w.end_seconds,
    })),
  }));

  const captionStyle = (projectRow.caption_style as ComposeCaptionStyle | null) ?? DEFAULT_CAPTION_STYLE;

  // Plan 13-22 B2: 'original' resolves to the FIRST (sort_order) non-deleted clip's stored pixel
  // dimensions — clipRows is already ordered by sort_order. Left undefined when the first clip's
  // dimensions were never probed; resolveComposeCanvas falls back to 1080x1920 in that case.
  const firstClip = clipRows[0];
  const originalCanvasWidth = projectRow.aspect_ratio === 'original' ? firstClip?.width ?? undefined : undefined;
  const originalCanvasHeight = projectRow.aspect_ratio === 'original' ? firstClip?.height ?? undefined : undefined;

  return {
    aspectRatio: projectRow.aspect_ratio as ComposeSpec['aspectRatio'],
    originalCanvasWidth,
    originalCanvasHeight,
    clips,
    textOverlays: textRows.map((t) => ({
      text: t.text,
      xNorm: t.x_norm ?? 0.5,
      yNorm: t.y_norm ?? 0.5,
      // widthNorm/rotation previously dropped here (T-13-19 gap) — export silently ignored scale
      // and there was no rotation field at all. Both now flow into the libass render path (G4).
      widthNorm: t.width_norm ?? 1,
      rotation: t.rotation ?? 0,
      startSeconds: t.start_seconds,
      endSeconds: t.end_seconds,
    })),
    audioClips,
    captionCues,
    captionStyle,
  };
}
