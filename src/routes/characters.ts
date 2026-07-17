import { Router } from 'express';
import { CHARACTERS_VERSION, CLIENT_CHARACTERS } from '../config/characters';

export const charactersRouter = Router();

charactersRouter.get('/', (_req, res) => {
  res.json({ version: CHARACTERS_VERSION, characters: CLIENT_CHARACTERS });
});
