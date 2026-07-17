import { Router } from 'express';
import { CLIENT_FORMATS, FORMATS_VERSION } from '../config/formats';

export const formatsRouter = Router();

formatsRouter.get('/', (_req, res) => {
  res.json({ version: FORMATS_VERSION, formats: CLIENT_FORMATS });
});
