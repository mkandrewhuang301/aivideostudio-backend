// src/middleware/banCheck.ts
// Ban check middleware — runs after authMiddleware for all /api/* routes.
// Reads req.user.banned (populated by authMiddleware's upsert/cache — see auth.ts) instead of
// its own query; this used to be a second serial DB round trip reading the same users row
// authMiddleware had just fetched. Returns 403 if true.
// No auto-ban trigger — admin sets banned=true directly via DB. Since authMiddleware caches
// dbUserId/banned for up to 60s, a freshly-applied ban can take up to that long to take effect.

import { Request, Response, NextFunction } from 'express';

export function banCheckMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.user?.banned === true) {
    res.status(403).json({ error: 'Account suspended' });
    return;
  }
  next();
}
