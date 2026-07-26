import { Router } from 'express';

export const audioVoicesRouter = Router();

audioVoicesRouter.get('/', async (_req, res) => {
  res.status(501).json({ error: 'not implemented' });
});
