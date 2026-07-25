// Character-vlog dispatch (v1 ONE-SHOT, 2026-07-25 lock — the 7/24 multi-take planner shape is
// shelved). Dedicated route, mirroring the videoSummaries pattern: this format's inputs
// (character + one beat + clip length) don't fit formatResolver's explainer shape, so
// validation/cost are server-owned here and the client's model/duration/cost fields are never
// read.

import { Router, Request, Response } from 'express';
import { CHARACTER_VLOG_FORMAT } from '../config/formats';
import { SERVER_CHARACTERS } from '../config/characters';
import { concurrencyGate } from '../middleware/concurrencyGate';
import { isPromptFlagged } from '../middleware/promptModeration';
import { deductCredits, refundCredits } from '../services/creditService';
import {
  createGeneration,
  markFailed,
  type SupportedModel,
} from '../services/generationService';
import { vlogGenerationQueue } from '../queue/vlogGenerationQueue';

export const characterVlogsRouter = Router();

const MAX_BEAT_CHARS = 600;
/** Server-owned provider routing — never client-readable. */
const VLOG_MODEL: SupportedModel = 'bytedance/seedance-2.0-mini';

/** Bill = clip seconds × the format's per-second credits (7/25: 6cr/s covers Mini $0.05/s +
 *  the haiku expansion pass + the per-beat qwen clone, ~$0.052/s all-in). ceil per the
 *  1-credit = 1¢ round-up convention. */
export function computeVlogCostCredits(durationSeconds: number): number {
  return Math.ceil(durationSeconds * (CHARACTER_VLOG_FORMAT?.per_second_credits ?? 6));
}

characterVlogsRouter.post(
  '/',
  concurrencyGate,
  async (req: Request, res: Response) => {
    const userId = req.user?.dbUserId;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const characterId = typeof req.body?.character_id === 'string' ? req.body.character_id : '';
    const beat = typeof req.body?.beat === 'string' ? req.body.beat.trim() : '';
    const durationSeconds = Number(req.body?.duration_seconds);

    const character = SERVER_CHARACTERS.find((def) => def.character_id === characterId);
    if (!character?.vlog) {
      res.status(400).json({ error: 'Invalid character', code: 'INVALID_CHARACTER' });
      return;
    }
    if (!beat || beat.length > MAX_BEAT_CHARS) {
      res.status(400).json({ error: 'Invalid beat', code: 'INVALID_INPUT' });
      return;
    }
    if (!CHARACTER_VLOG_FORMAT?.duration_options.includes(durationSeconds)) {
      res.status(400).json({ error: 'Invalid duration', code: 'INVALID_DURATION' });
      return;
    }
    // Fictional characters only, no user media — prompt moderation on the beat is the whole
    // input gate for this format (no inputMediaGate equivalent needed).
    if (await isPromptFlagged(beat)) {
      res.status(400).json({ error: 'This beat violates our content policy', code: 'content_policy_violation' });
      return;
    }

    const cost = computeVlogCostCredits(durationSeconds);

    let generationId: string | undefined;
    try {
      if (!await deductCredits(userId, cost)) {
        res.status(402).json({ error: 'Insufficient credits', code: 'INSUFFICIENT_CREDITS', cost_credits: cost });
        return;
      }

      ({ id: generationId } = await createGeneration({
        user_id: userId,
        model: VLOG_MODEL,
        status: 'pending',
        prompt: beat,
        params: {
          format_id: 'character-vlog',
          character_id: characterId,
          beat,
          duration_seconds: durationSeconds,
        },
        cost_credits: cost,
        media_type: 'format',
        // Fictional character roster + no user media — never a real-face path.
        has_real_face_input: false,
      }));

      await vlogGenerationQueue.add('generate', {
        mode: 'create',
        generationId,
        userId,
        cost,
        characterId,
        beat,
        durationSeconds,
      });

      res.status(200).json({ generation_id: generationId, status: 'processing', cost_credits: cost });
    } catch (err) {
      console.error('[character-vlogs] Dispatch failed:', err);
      if (generationId) {
        await markFailed(generationId, 'generic_error');
        await refundCredits(userId, cost, `dispatch-failure-${generationId}`);
        res.status(502).json({ error: 'Generation service unavailable. Credits have been refunded.' });
      } else {
        res.status(500).json({ error: 'Failed to start generation' });
      }
    }
  },
);
