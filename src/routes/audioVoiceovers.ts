import { Router, Request, Response } from 'express';
import { voiceoverGenerationQueue } from '../queue/voiceoverGenerationQueue';
import {
  createVoiceoverGeneration,
  getVoiceover,
  getVoiceoverQuote,
  InsufficientVoiceoverCreditsError,
  refundVoiceover,
  VoiceoverNotFoundError,
  VoiceoverValidationError,
} from '../services/voiceoverService';

export const audioVoiceoversRouter = Router();

function userId(req: Request, res: Response): string | undefined {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Unauthorized' });
    return undefined;
  }
  return req.user.dbUserId;
}

audioVoiceoversRouter.post('/projects/:projectId/voiceover/quote', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  const voiceId = typeof req.body?.voice_id === 'string' ? req.body.voice_id : '';
  const script = typeof req.body?.script === 'string' ? req.body.script : '';
  try {
    const quote = await getVoiceoverQuote(req.params.projectId as string, uid, voiceId, script);
    if (!quote) { res.status(404).json({ error: 'Project not found' }); return; }
    res.status(200).json(quote);
  } catch (error) {
    if (error instanceof VoiceoverValidationError) { res.status(422).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to quote voiceover' });
  }
});

audioVoiceoversRouter.post('/projects/:projectId/voiceovers', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  const idempotencyKey = req.header('Idempotency-Key')?.trim();
  if (!idempotencyKey || idempotencyKey.length > 100) {
    res.status(400).json({ error: 'A valid Idempotency-Key is required' }); return;
  }
  const voiceId = typeof req.body?.voice_id === 'string' ? req.body.voice_id : '';
  const script = typeof req.body?.script === 'string' ? req.body.script : '';
  try {
    const created = await createVoiceoverGeneration({
      projectId: req.params.projectId as string,
      userId: uid,
      idempotencyKey,
      voiceId,
      script,
    });
    if (created.created) {
      try {
        await voiceoverGenerationQueue.add('generate', { voiceoverId: created.row.id }, { jobId: created.row.id });
      } catch {
        await refundVoiceover(created.row.id, 'queue_unavailable', 'Voiceover generation could not start');
        res.status(503).json({ error: 'Voiceover generation is temporarily unavailable' }); return;
      }
    }
    res.status(202).json({
      voiceover_id: created.row.id,
      status: created.row.status,
      voice_id: created.row.voice_id,
      script_preview: created.row.script.slice(0, 120),
      cost_credits: created.row.cost_credits,
      created_at: created.row.created_at,
    });
  } catch (error) {
    if (error instanceof VoiceoverNotFoundError) { res.status(404).json({ error: 'Project not found' }); return; }
    if (error instanceof InsufficientVoiceoverCreditsError) { res.status(402).json({ error: 'Not enough credits' }); return; }
    if (error instanceof VoiceoverValidationError) { res.status(422).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to start voiceover' });
  }
});

audioVoiceoversRouter.get('/projects/:projectId/voiceovers/:voiceoverId', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  const value = await getVoiceover(
    req.params.voiceoverId as string,
    req.params.projectId as string,
    uid,
  );
  if (!value) { res.status(404).json({ error: 'Voiceover not found' }); return; }
  res.status(200).json(value);
});
