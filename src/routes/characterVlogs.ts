// Character-vlog dispatch (gorilla multi-take, 2026-07-24 spec). Dedicated route, mirroring
// the videoSummaries pattern: this format's inputs (character + topic + total length) don't
// fit formatResolver's explainer shape, so validation/cost are server-owned here and the
// client's model/duration/cost fields are never read.

import { Router, Request, Response } from 'express';
import { CHARACTER_VLOG_FORMAT } from '../config/formats';
import { SERVER_CHARACTERS } from '../config/characters';
import { concurrencyGate } from '../middleware/concurrencyGate';
import { isPromptFlagged } from '../middleware/promptModeration';
import { deductCredits, refundCredits } from '../services/creditService';
import {
  computeCostCredits,
  createGeneration,
  markFailed,
  type SupportedModel,
} from '../services/generationService';
import { vlogGenerationQueue } from '../queue/vlogGenerationQueue';

export const characterVlogsRouter = Router();

const MAX_TOPIC_CHARS = 600;
const MAX_VIBE_CHARS = 200;
/** Server-owned provider routing — never client-readable. */
const VLOG_MODEL: SupportedModel = 'bytedance/seedance-2.0-mini';

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
    const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
    const vibe = typeof req.body?.vibe === 'string' ? req.body.vibe.trim() : '';
    const totalSeconds = Number(req.body?.total_seconds);

    const character = SERVER_CHARACTERS.find((def) => def.character_id === characterId);
    if (!character?.vlog) {
      res.status(400).json({ error: 'Invalid character', code: 'INVALID_CHARACTER' });
      return;
    }
    if (!topic || topic.length > MAX_TOPIC_CHARS) {
      res.status(400).json({ error: 'Invalid topic', code: 'INVALID_INPUT' });
      return;
    }
    if (vibe.length > MAX_VIBE_CHARS) {
      res.status(400).json({ error: 'Invalid vibe', code: 'INVALID_INPUT' });
      return;
    }
    if (!CHARACTER_VLOG_FORMAT?.duration_options.includes(totalSeconds)) {
      res.status(400).json({ error: 'Invalid duration', code: 'INVALID_DURATION' });
      return;
    }
    // Fictional characters only, no user media — prompt moderation on the topic/vibe is the
    // whole input gate for this format (no inputMediaGate equivalent needed).
    if (await isPromptFlagged(topic) || (vibe && await isPromptFlagged(vibe))) {
      res.status(400).json({ error: 'This topic violates our content policy', code: 'content_policy_violation' });
      return;
    }

    // Bill = TOTAL seconds, upfront (spec §8). Mini $0.05/s 720p nonVideoIn → 1 credit = 1¢
    // rounded up: 15s→75, 30s→150, 45s→225, 60s→300.
    const cost = computeCostCredits({
      durationSeconds: totalSeconds,
      resolution: '720p',
      model: VLOG_MODEL,
    });

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
        prompt: topic,
        params: {
          format_id: 'character-vlog',
          character_id: characterId,
          topic,
          ...(vibe ? { vibe } : {}),
          total_seconds: totalSeconds,
        },
        cost_credits: cost,
        media_type: 'format',
        // Fictional character roster + no user media — never a real-face path.
        has_real_face_input: false,
      }));

      await vlogGenerationQueue.add('generate', {
        mode: 'plan',
        generationId,
        userId,
        cost,
        characterId,
        topic,
        ...(vibe ? { vibe } : {}),
        totalSeconds,
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
