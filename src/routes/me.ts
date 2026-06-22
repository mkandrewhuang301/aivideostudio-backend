// src/routes/me.ts
// Smoke-test endpoint that returns the authenticated user's info from req.user
import { Router, Request, Response } from 'express';

export const meRouter = Router();

meRouter.get('/', (req: Request, res: Response) => {
  res.status(200).json({ user: req.user });
});
