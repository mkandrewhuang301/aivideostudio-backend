import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
import { deleteUserAccount } from '../services/accountDeletionService';

async function main(): Promise<void> {
  const userId = randomUUID();
  const firebaseUid = `delete-account-e2e-${randomUUID()}`;
  const generationId = randomUUID();
  const projectId = randomUUID();
  const cueId = randomUUID();
  const marker = randomUUID();

  await db.insert(users).values({
    id: userId,
    firebase_uid: firebaseUid,
    email: `${marker}@example.invalid`,
    credits_balance: 42,
  });
  await db.insert(creditTransactions).values({
    user_id: userId,
    amount: 42,
    type: 'topup_grant',
    reference_id: `delete-account-e2e-${marker}`,
  });
  await db.insert(generations).values({
    id: generationId,
    user_id: userId,
    model: 'delete-account-e2e/fake-model',
    status: 'completed',
    cost_credits: 1,
    r2_key: `delete-account-e2e/${marker}/generation.mp4`,
  });
  await db.insert(referenceUploads).values({
    user_id: userId,
    r2_key: `delete-account-e2e/${marker}/upload.jpg`,
    mime_type: 'image/jpeg',
  });
  await db.insert(reports).values({
    generationId,
    userId: firebaseUid,
    reason: 'other',
    freeText: 'delete-account end-to-end fixture',
  });
  await db.insert(projects).values({
    id: projectId,
    user_id: userId,
    title: 'Delete Account E2E',
    thumbnail_r2_key: `delete-account-e2e/${marker}/thumbnail.jpg`,
  });
  await db.insert(projectClips).values({
    project_id: projectId,
    sort_order: 0,
    r2_key: `delete-account-e2e/${marker}/clip.mp4`,
    media_type: 'video',
    source_type: 'upload',
  });
  await db.insert(projectTextOverlays).values({
    project_id: projectId,
    text: 'Delete me',
    start_seconds: 0,
    end_seconds: 1,
  });
  await db.insert(projectAudioClips).values({
    project_id: projectId,
    r2_key: `delete-account-e2e/${marker}/audio.mp3`,
  });
  await db.insert(projectCaptionCues).values({
    id: cueId,
    project_id: projectId,
    sort_order: 0,
    start_seconds: 0,
    end_seconds: 1,
  });
  await db.insert(projectCaptionWords).values({
    cue_id: cueId,
    text: 'Delete',
    start_seconds: 0,
    end_seconds: 1,
    sort_order: 0,
  });

  const seededCounts = {
    users: (await db.select().from(users).where(eq(users.id, userId))).length,
    credit_transactions: (await db.select().from(creditTransactions).where(eq(creditTransactions.user_id, userId))).length,
    generations: (await db.select().from(generations).where(eq(generations.user_id, userId))).length,
    reference_uploads: (await db.select().from(referenceUploads).where(eq(referenceUploads.user_id, userId))).length,
    reports: (await db.select().from(reports).where(eq(reports.userId, firebaseUid))).length,
    projects: (await db.select().from(projects).where(eq(projects.user_id, userId))).length,
    project_clips: (await db.select().from(projectClips).where(eq(projectClips.project_id, projectId))).length,
    project_text_overlays: (await db.select().from(projectTextOverlays).where(eq(projectTextOverlays.project_id, projectId))).length,
    project_audio_clips: (await db.select().from(projectAudioClips).where(eq(projectAudioClips.project_id, projectId))).length,
    project_caption_cues: (await db.select().from(projectCaptionCues).where(eq(projectCaptionCues.project_id, projectId))).length,
    project_caption_words: (await db.select().from(projectCaptionWords).where(eq(projectCaptionWords.cue_id, cueId))).length,
  };
  console.log('[delete-account-e2e] seeded counts:', seededCounts);
  for (const [table, count] of Object.entries(seededCounts)) {
    assert.equal(count, 1, `expected one seeded row in ${table}`);
  }

  await deleteUserAccount(userId, firebaseUid, { skipFirebase: true });

  const remainingCounts = {
    users: (await db.select().from(users).where(eq(users.id, userId))).length,
    credit_transactions: (await db.select().from(creditTransactions).where(eq(creditTransactions.user_id, userId))).length,
    generations: (await db.select().from(generations).where(eq(generations.user_id, userId))).length,
    reference_uploads: (await db.select().from(referenceUploads).where(eq(referenceUploads.user_id, userId))).length,
    reports: (await db.select().from(reports).where(eq(reports.userId, firebaseUid))).length,
    projects: (await db.select().from(projects).where(eq(projects.user_id, userId))).length,
    project_clips: (await db.select().from(projectClips).where(eq(projectClips.project_id, projectId))).length,
    project_text_overlays: (await db.select().from(projectTextOverlays).where(eq(projectTextOverlays.project_id, projectId))).length,
    project_audio_clips: (await db.select().from(projectAudioClips).where(eq(projectAudioClips.project_id, projectId))).length,
    project_caption_cues: (await db.select().from(projectCaptionCues).where(eq(projectCaptionCues.project_id, projectId))).length,
    project_caption_words: (await db.select().from(projectCaptionWords).where(eq(projectCaptionWords.cue_id, cueId))).length,
  };
  console.log('[delete-account-e2e] remaining counts:', remainingCounts);
  for (const [table, count] of Object.entries(remainingCounts)) {
    assert.equal(count, 0, `expected zero remaining rows in ${table}`);
  }
  console.log('[delete-account-e2e] PASS: all seeded rows deleted (Firebase skipped for dev proof)');
}

main().catch((error) => {
  console.error('[delete-account-e2e] FAIL:', error);
  process.exitCode = 1;
});
