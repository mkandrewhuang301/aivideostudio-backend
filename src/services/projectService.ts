// src/services/projectService.ts
// Phase 13 (Edit Studio): project CRUD, import-by-copy (D-03), and the generalized
// "smart unpack" import hook (D-15/D-16). Every function that touches a project or a
// generation ownership-scopes its query by user_id — no unscoped lookups (T-13-07/T-13-08).
//
// CLAUDE.md Rule 2 (provider URLs expire) applies equally to R2 presigned URLs here:
// getProjectWithState/listProjects never return a bare r2_key — always a fresh presigned url
// generated at query time via archivalService.getUploadPresignedUrl (1h TTL).

import { randomUUID } from 'crypto';
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
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
import { eq, and, desc, lt, or, sql, inArray } from 'drizzle-orm';
import { getUploadPresignedUrl } from './archivalService';

// DoS guard (T-13-10): route layer enforces this cap before calling importClipByCopy.
export const MAX_CLIPS_PER_PROJECT = 50;
// DoS guards (T-13-16) for the element tracks added in Plan 04.
export const MAX_TEXT_OVERLAYS_PER_PROJECT = 30;
export const MAX_AUDIO_CLIPS_PER_PROJECT = 10;

// Thrown by importClipByCopy when the source generation doesn't exist, isn't owned by the
// requesting user, or isn't completed yet — the route maps this to a 404, never a 500.
export class ImportSourceNotFoundError extends Error {}

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
      aspect_ratio: opts.aspectRatio ?? '9:16',
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

  const [clipRows, textRows, audioRows, cueRows] = await Promise.all([
    db.select().from(projectClips).where(eq(projectClips.project_id, projectId)).orderBy(projectClips.sort_order),
    db
      .select()
      .from(projectTextOverlays)
      .where(eq(projectTextOverlays.project_id, projectId))
      .orderBy(projectTextOverlays.start_seconds),
    db
      .select()
      .from(projectAudioClips)
      .where(eq(projectAudioClips.project_id, projectId))
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
      return { ...rest, url: await getUploadPresignedUrl(r2_key) };
    }),
  );
  const audioClips: ProjectAudioClipWithUrl[] = await Promise.all(
    audioRows.map(async (a) => {
      const { r2_key, ...rest } = a;
      return { ...rest, url: await getUploadPresignedUrl(r2_key) };
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
}

// Copy-not-reference (D-03): for 'generation' sources this resolves the source generation
// SCOPED BY user_id (ownership — REQUIRED, mirrors uploads.ts's /from-generation, T-13-08) before
// issuing a server-side R2-to-R2 copy. For 'upload' sources the file was already written directly
// to projects/{id}/clips/ by the route (a fresh upload has no prior owner to protect against).
export async function importClipByCopy(input: ImportClipParams): Promise<ProjectClip> {
  const { projectId, userId, sourceType, sourceId, uploadedR2Key, mediaType, durationSeconds, mimeType } = input;

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
  } else {
    if (!uploadedR2Key) throw new Error('uploadedR2Key is required for sourceType=upload');
    r2Key = uploadedR2Key;
  }

  const nextOrderResult = await db.execute(sql`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM project_clips WHERE project_id = ${projectId}::uuid
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
    })
    .returning();

  return clip;
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
  startSeconds: number;
  endSeconds: number;
}
export interface UpdateTextOverlayInput {
  text?: string;
  xNorm?: number;
  yNorm?: number;
  widthNorm?: number;
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
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM project_audio_clips WHERE project_id = ${projectId}::uuid
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
    .where(and(eq(projectAudioClips.id, audioId), eq(projectAudioClips.project_id, projectId)))
    .returning();
  return row ?? null;
}

// Deletes the row AND its R2 object (best-effort on the R2 side, matching deleteProject's
// established pattern — a stray orphaned R2 object is a minor storage cost, not a correctness bug).
export async function deleteAudioClip(projectId: string, userId: string, audioId: string): Promise<boolean> {
  if (!(await isProjectOwned(projectId, userId))) return false;

  const [row] = await db
    .select({ r2_key: projectAudioClips.r2_key })
    .from(projectAudioClips)
    .where(and(eq(projectAudioClips.id, audioId), eq(projectAudioClips.project_id, projectId)));
  if (!row) return false;

  await db.delete(projectAudioClips).where(eq(projectAudioClips.id, audioId));
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: row.r2_key }));
  } catch (err) {
    console.error('[projectService] Best-effort delete of audio clip R2 object failed:', err);
  }
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
export interface StructuredImportData {
  captionCues?: StructuredCaptionCue[];
  audioStems?: StructuredAudioStem[];
}

// GENERALIZED mechanism (not autoexplainer-specific): if the source generation's params.structured
// marker carries captionCues and/or audioStems, unpack them directly into project_audio_clips /
// project_caption_cues+words instead of the caller importing one opaque clip. No marker → no-op,
// normal single-clip import proceeds unaffected. This is Phase 14's stable write target (D-15/D-16) —
// the {text, start, end}-per-word shape matches the AI Autoexplainer pipeline design note verbatim.
export async function smartUnpackOnImport(
  projectId: string,
  sourceGeneration: { id: string; params: unknown },
): Promise<{ unpacked: boolean }> {
  const params = (sourceGeneration.params ?? null) as Record<string, unknown> | null;
  const structured = params?.structured as StructuredImportData | undefined;
  const audioStems = structured?.audioStems ?? [];
  const captionCues = structured?.captionCues ?? [];

  if (!structured || (audioStems.length === 0 && captionCues.length === 0)) {
    return { unpacked: false };
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

  return { unpacked: true };
}
