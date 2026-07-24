import { Router, Request, Response } from 'express';
import { config } from '../config';
import { soundtrackGenerationQueue } from '../queue/soundtrackGenerationQueue';
import { suggestionsForProject } from '../services/musicSuggestionService';
import {
  attachSoundtrack,
  createSoundtrackGeneration,
  deleteSoundtrackFromLibrary,
  getSoundtrack,
  getSoundtrackQuote,
  InsufficientSoundtrackCreditsError,
  listSoundtracks,
  renameSoundtrack,
  refundSoundtrack,
  SoundtrackNotFoundError,
  SoundtrackValidationError,
} from '../services/soundtrackService';

export const aiMusicRouter = Router();

function userId(req: Request, res: Response): string | undefined {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Unauthorized' });
    return undefined;
  }
  return req.user.dbUserId;
}

aiMusicRouter.get('/projects/:projectId/ai-soundtrack/quote', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  try {
    const quote = await getSoundtrackQuote(req.params.projectId as string, uid);
    if (!quote) { res.status(404).json({ error: 'Project not found' }); return; }
    res.status(200).json({ ...quote, enabled: config.aiMusicEnabled });
  } catch (error) {
    if (error instanceof SoundtrackValidationError) { res.status(422).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to quote AI Music' });
  }
});

aiMusicRouter.post('/projects/:projectId/ai-soundtrack/suggestions', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  try {
    res.status(200).json(await suggestionsForProject(req.params.projectId as string, uid));
  } catch (error) {
    if (error instanceof SoundtrackNotFoundError) { res.status(404).json({ error: 'Project not found' }); return; }
    res.status(503).json({ error: 'Suggestions are temporarily unavailable' });
  }
});

aiMusicRouter.post('/projects/:projectId/ai-soundtracks', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  if (!config.aiMusicEnabled) { res.status(503).json({ error: 'AI Music is not enabled' }); return; }
  const idempotencyKey = req.header('Idempotency-Key')?.trim();
  if (!idempotencyKey || idempotencyKey.length > 100) {
    res.status(400).json({ error: 'A valid Idempotency-Key is required' }); return;
  }
  const soundMode = req.body?.sound_mode;
  if (soundMode !== 'instrumental' && soundMode !== 'vocals') {
    res.status(400).json({ error: 'sound_mode must be instrumental or vocals' }); return;
  }
  try {
    const created = await createSoundtrackGeneration({
      projectId: req.params.projectId as string,
      userId: uid,
      idempotencyKey,
      soundMode,
      direction: typeof req.body?.direction === 'string' ? req.body.direction : null,
    });
    if (created.created) {
      try {
        await soundtrackGenerationQueue.add('generate', { soundtrackId: created.row.id }, { jobId: created.row.id });
      } catch {
        await refundSoundtrack(created.row.id, 'queue_unavailable', 'Music generation could not start');
        res.status(503).json({ error: 'AI Music is temporarily unavailable' }); return;
      }
    }
    res.status(202).json({
      soundtrack_id: created.row.id,
      status: created.row.status,
      project_duration_seconds: created.row.project_duration_seconds,
      cost_credits: created.row.cost_credits,
    });
  } catch (error) {
    if (error instanceof SoundtrackNotFoundError) { res.status(404).json({ error: 'Project not found' }); return; }
    if (error instanceof InsufficientSoundtrackCreditsError) { res.status(402).json({ error: 'Not enough credits' }); return; }
    if (error instanceof SoundtrackValidationError) { res.status(422).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to start AI Music' });
  }
});

aiMusicRouter.get('/projects/:projectId/ai-soundtracks/:soundtrackId', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  const value = await getSoundtrack(
    req.params.soundtrackId as string,
    req.params.projectId as string,
    uid,
  );
  if (!value) { res.status(404).json({ error: 'Soundtrack not found' }); return; }
  res.status(200).json(value);
});

aiMusicRouter.post('/projects/:projectId/ai-soundtracks/:soundtrackId/attach', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  const clip = await attachSoundtrack(
    req.params.projectId as string,
    req.params.soundtrackId as string,
    uid,
  );
  if (!clip) { res.status(404).json({ error: 'Soundtrack not found' }); return; }
  res.status(200).json({ audio_clip: clip });
});

aiMusicRouter.get('/ai-music', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  res.status(200).json({ items: await listSoundtracks(uid) });
});

aiMusicRouter.patch('/ai-music/:soundtrackId', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  try {
    const value = await renameSoundtrack(
      req.params.soundtrackId as string,
      uid,
      typeof req.body?.display_name === 'string' ? req.body.display_name : '',
    );
    if (!value) { res.status(404).json({ error: 'Soundtrack not found' }); return; }
    res.status(200).json(value);
  } catch (error) {
    if (error instanceof SoundtrackValidationError) { res.status(400).json({ error: error.message }); return; }
    res.status(500).json({ error: 'Failed to rename soundtrack' });
  }
});

aiMusicRouter.delete('/ai-music/:soundtrackId', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  const deleted = await deleteSoundtrackFromLibrary(req.params.soundtrackId as string, uid);
  if (!deleted) { res.status(404).json({ error: 'Soundtrack not found' }); return; }
  res.status(204).send();
});

aiMusicRouter.post('/projects/:projectId/audio/from-ai/:soundtrackId', async (req, res) => {
  const uid = userId(req, res); if (!uid) return;
  const clip = await attachSoundtrack(
    req.params.projectId as string,
    req.params.soundtrackId as string,
    uid,
  );
  if (!clip) { res.status(404).json({ error: 'Soundtrack or project not found' }); return; }
  res.status(201).json({ audio_clip: clip });
});
