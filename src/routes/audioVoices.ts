// src/routes/audioVoices.ts
// Authenticated, safe voice roster for the AI Voiceover tool. Provider and clone metadata stay
// server-side; only signed preview URLs cross the boundary.

import { Router } from 'express';
import { AUDIO_VOICES_VERSION, CLIENT_AUDIO_VOICES } from '../config/audioVoices';
import { getUploadPresignedUrl } from '../services/archivalService';

export const audioVoicesRouter = Router();

audioVoicesRouter.get('/', async (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const voices = await Promise.all(
    CLIENT_AUDIO_VOICES.map(async (voice) => ({
      ...voice,
      previewUrl: voice.previewUrl
        ? await getUploadPresignedUrl(voice.previewUrl)
        : undefined,
    })),
  );

  res.json({ version: AUDIO_VOICES_VERSION, voices });
});
