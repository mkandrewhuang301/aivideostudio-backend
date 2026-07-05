// src/routes/presets.ts
// Public endpoint — no auth required (mirrors routes/rates.ts). Serves the preset registry
// so iOS can render Home (and every future preset UI) purely from server config — a new
// preset ships via backend deploy, no app release (SC1).

import { Router } from 'express';
import { CLIENT_PRESETS, PRESETS_VERSION } from '../config/presets';

export const presetsRouter = Router();

presetsRouter.get('/', (_req, res) => {
  res.json({ version: PRESETS_VERSION, presets: CLIENT_PRESETS });
});
