// src/services/uploadCleanup.ts
// Shared raw-upload cleanup helper. Extracted from routes/webhooks/replicate.ts (09.2-12) so it
// can be called from BOTH the Replicate webhook success path AND the inline (no-webhook) OpenAI
// faceswap completion path (SC1 — the raw uploaded face must still be reaped even when a job
// completes inline and never hits the webhook).

import { db } from '../db/client';
import { referenceUploads } from '../db/schema';
import { eq } from 'drizzle-orm';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../storage/r2';
import { FACE_INPUT_PRESET_IDS, FACE_INPUT_MEDIA_TYPES } from '../config/faceInputPresets';
import type { GenerationByPredictionRow } from './generationService';

// SC1: delete raw face uploads post-archive. Only for face-input presets. My Look is out of 9.2
// scope (D-3) so all face-input uploads are ephemeral — no kind exemption. Best-effort — a
// failure must not break the caller (webhook or inline route).
export async function deleteRawFaceUploads(generation: GenerationByPredictionRow): Promise<void> {
  const params = (generation.params ?? {}) as Record<string, unknown>;
  const presetId = typeof params.preset_id === 'string' ? params.preset_id : undefined;
  const isFaceInput =
    (presetId && FACE_INPUT_PRESET_IDS.has(presetId)) ||
    FACE_INPUT_MEDIA_TYPES.has(generation.media_type);
  if (!isFaceInput) return;
  const uploadIds: string[] = Array.isArray(params.preset_input_upload_ids)
    ? (params.preset_input_upload_ids as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  if (uploadIds.length === 0) return;
  for (const uploadId of uploadIds) {
    try {
      const [row] = await db
        .select()
        .from(referenceUploads)
        .where(eq(referenceUploads.id, uploadId));
      if (!row) continue; // already gone → skip
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: row.r2_key }));
      await db.delete(referenceUploads).where(eq(referenceUploads.id, uploadId));
    } catch (err) {
      console.error(`[uploadCleanup] raw-face deletion failed for upload ${uploadId}:`, err);
    }
  }
}
