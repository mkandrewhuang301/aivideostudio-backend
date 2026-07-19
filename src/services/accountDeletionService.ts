import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { eq, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  creditTransactions,
  generations,
  projectAudioClips,
  projectCaptionCues,
  projectCaptionWords,
  projectClips,
  projects,
  projectTextOverlays,
  referenceUploads,
  reports,
  users,
} from '../db/schema';
import { getFirebaseAdmin } from '../firebase';
import { evictAuthCache } from '../middleware/auth';
import { R2_BUCKET, r2 } from '../storage/r2';

export interface DeleteUserAccountOptions {
  skipFirebase?: boolean;
}

async function collectUserR2Keys(dbUserId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT r2_key FROM generations
      WHERE user_id = ${dbUserId}::uuid AND r2_key IS NOT NULL
    UNION ALL
    SELECT r2_key FROM reference_uploads
      WHERE user_id = ${dbUserId}::uuid
    UNION ALL
    SELECT thumbnail_r2_key AS r2_key FROM projects
      WHERE user_id = ${dbUserId}::uuid AND thumbnail_r2_key IS NOT NULL
    UNION ALL
    SELECT pc.r2_key FROM project_clips pc
      INNER JOIN projects p ON p.id = pc.project_id
      WHERE p.user_id = ${dbUserId}::uuid
    UNION ALL
    SELECT pa.r2_key FROM project_audio_clips pa
      INNER JOIN projects p ON p.id = pa.project_id
      WHERE p.user_id = ${dbUserId}::uuid
  `);

  const keys = (result.rows ?? [])
    .map((row) => (row as { r2_key?: unknown }).r2_key)
    .filter((key): key is string => typeof key === 'string' && key.length > 0);
  return [...new Set(keys)];
}

async function deleteR2Objects(keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    } catch (error) {
      console.error(`[account-deletion] Failed to delete R2 object ${key}:`, error);
    }
  }
}

export async function deleteUserAccount(
  dbUserId: string,
  firebaseUid: string,
  options: DeleteUserAccountOptions = {},
): Promise<void> {
  const r2Keys = await collectUserR2Keys(dbUserId);
  await deleteR2Objects(r2Keys);

  // Neon HTTP does not support interactive transactions. Drizzle's batch API sends every
  // statement below through Neon's transaction() API as one atomic transaction.
  await db.batch([
    db.delete(projectCaptionWords).where(sql`${projectCaptionWords.cue_id} IN (
      SELECT cue.id FROM project_caption_cues cue
      INNER JOIN projects project ON project.id = cue.project_id
      WHERE project.user_id = ${dbUserId}::uuid
    )`),
    db.delete(projectCaptionCues).where(sql`${projectCaptionCues.project_id} IN (
      SELECT id FROM projects WHERE user_id = ${dbUserId}::uuid
    )`),
    db.delete(projectAudioClips).where(sql`${projectAudioClips.project_id} IN (
      SELECT id FROM projects WHERE user_id = ${dbUserId}::uuid
    )`),
    db.delete(projectTextOverlays).where(sql`${projectTextOverlays.project_id} IN (
      SELECT id FROM projects WHERE user_id = ${dbUserId}::uuid
    )`),
    db.delete(projectClips).where(sql`${projectClips.project_id} IN (
      SELECT id FROM projects WHERE user_id = ${dbUserId}::uuid
    )`),
    db.delete(projects).where(eq(projects.user_id, dbUserId)),
    // A report can be owned by this user or reference one of this user's generations. Both
    // relationships must be removed before deleting generations to satisfy both report FKs.
    db.delete(reports).where(or(
      eq(reports.userId, firebaseUid),
      sql`${reports.generationId} IN (
        SELECT id FROM generations WHERE user_id = ${dbUserId}::uuid
      )`,
    )),
    db.delete(generations).where(eq(generations.user_id, dbUserId)),
    db.delete(referenceUploads).where(eq(referenceUploads.user_id, dbUserId)),
    db.delete(creditTransactions).where(eq(creditTransactions.user_id, dbUserId)),
    db.delete(users).where(eq(users.id, dbUserId)),
  ] as const);

  if (!options.skipFirebase) {
    try {
      await getFirebaseAdmin().auth.deleteUser(firebaseUid);
    } catch (error) {
      // The DB deletion is already committed. Auth middleware auto-provisions a fresh users row
      // for any still-valid Firebase uid, so this orphan must not turn a completed deletion into
      // a retry that can no longer find the original data.
      console.error(`[account-deletion] CRITICAL: Firebase user deletion failed for uid ${firebaseUid}:`, error);
    }
  }

  evictAuthCache(firebaseUid);
}
