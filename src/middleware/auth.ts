// src/middleware/auth.ts
// Firebase JWT verification middleware with auto-upsert of users table
import { Request, Response, NextFunction } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { getFirebaseAdmin } from '../firebase';

// Augment Express Request type to include authenticated user context
declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
        email?: string;
        dbUserId?: string;
      };
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const { auth } = getFirebaseAdmin();
    const decoded = await auth.verifyIdToken(idToken);

    // Auto-upsert: provision user row on first authenticated request (atomic, no separate SELECT)
    const [dbUser] = await db
      .insert(users)
      .values({
        firebase_uid: decoded.uid,
        email: decoded.email ?? null,
      })
      .onConflictDoUpdate({
        target: users.firebase_uid,
        set: {
          email: decoded.email ?? null,
          updated_at: sql`now()`,
        },
      })
      .returning({ id: users.id });

    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      dbUserId: dbUser?.id,
    };

    next();
  } catch (error) {
    const code = (error as { code?: string }).code;

    if (code === 'auth/id-token-expired') {
      res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
      return;
    }

    if (code === 'auth/id-token-revoked') {
      res.status(401).json({ error: 'Token revoked', code: 'TOKEN_REVOKED' });
      return;
    }

    res.status(401).json({ error: 'Invalid token', code: 'TOKEN_INVALID' });
  }
}
