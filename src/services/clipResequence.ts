// Plan 13-25 L6: RESEQUENCE with move semantics when a clip/audio PATCH includes sort_order.
// Naive SET sort_order = N left two clips sharing one value → stable client sort looked
// unchanged ("reorder reverts on release"). Soft-deleted rows are excluded and keep their
// old sort_order. neon-http has no interactive transactions — sequential UPDATEs are fine.

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { projectAudioClips, projectClips } from '../db/schema';
import type { ProjectAudioClip, ProjectClip } from '../db/schema';

export async function resequenceClipSortOrder(
  projectId: string,
  clipId: string,
  requestedSortOrder: number,
): Promise<ProjectClip | null> {
  const clips = await db
    .select()
    .from(projectClips)
    .where(and(eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)))
    .orderBy(asc(projectClips.sort_order), asc(projectClips.created_at));

  const fromIndex = clips.findIndex((c) => c.id === clipId);
  if (fromIndex < 0) return null;

  let toIndex = clips.findIndex((c) => c.sort_order === requestedSortOrder);
  if (toIndex < 0) toIndex = clips.length;

  const working = [...clips];
  const [moved] = working.splice(fromIndex, 1);
  const insertAt = Math.min(toIndex, working.length);
  working.splice(insertAt, 0, moved);

  let result: ProjectClip | null = null;
  for (let i = 0; i < working.length; i++) {
    const [row] = await db
      .update(projectClips)
      .set({ sort_order: i })
      .where(and(eq(projectClips.id, working[i].id), eq(projectClips.project_id, projectId)))
      .returning();
    if (working[i].id === clipId) result = row ?? null;
  }
  return result;
}

export async function resequenceAudioClipSortOrder(
  projectId: string,
  audioId: string,
  requestedSortOrder: number,
): Promise<ProjectAudioClip | null> {
  const clips = await db
    .select()
    .from(projectAudioClips)
    .where(and(eq(projectAudioClips.project_id, projectId), isNull(projectAudioClips.deleted_at)))
    .orderBy(asc(projectAudioClips.sort_order), asc(projectAudioClips.created_at));

  const fromIndex = clips.findIndex((c) => c.id === audioId);
  if (fromIndex < 0) return null;

  let toIndex = clips.findIndex((c) => c.sort_order === requestedSortOrder);
  if (toIndex < 0) toIndex = clips.length;

  const working = [...clips];
  const [moved] = working.splice(fromIndex, 1);
  const insertAt = Math.min(toIndex, working.length);
  working.splice(insertAt, 0, moved);

  let result: ProjectAudioClip | null = null;
  for (let i = 0; i < working.length; i++) {
    const [row] = await db
      .update(projectAudioClips)
      .set({ sort_order: i })
      .where(and(eq(projectAudioClips.id, working[i].id), eq(projectAudioClips.project_id, projectId)))
      .returning();
    if (working[i].id === audioId) result = row ?? null;
  }
  return result;
}
