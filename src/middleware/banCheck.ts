// src/middleware/banCheck.ts
// Ban check middleware — runs after authMiddleware for all /api/* routes.
// Queries users.banned (added to schema in 05-01). Returns 403 if true.
// No auto-ban trigger — admin sets banned=true directly via DB.
// Fail-open: if DB is unavailable, do not block the user (availability > security for this check).

import { Request, Response, NextFunction } from 'express';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';

export async function banCheckMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const dbUserId = req.user?.dbUserId;

  if (!dbUserId) {
    // authMiddleware would have already rejected unauthenticated requests on /api routes.
    // Pass through if no user context (e.g. unauthenticated routes that share a middleware chain).
    next();
    return;
  }

  try {
    const result = await db.execute(sql`
      SELECT banned FROM users WHERE id = ${dbUserId}::uuid
    `);
    const user = result.rows?.[0] as { banned: boolean } | undefined;

    if (user?.banned === true) {
      res.status(403).json({ error: 'Account suspended' });
      return;
    }

    next();
  } catch (err) {
    console.error('[banCheck] Error checking ban status:', err);
    // Fail open: if DB is unavailable, do not block the user
    next();
  }
}
