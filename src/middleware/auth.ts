// src/middleware/auth.ts
// Firebase JWT verification middleware with auto-upsert of users table.
// Perf: the upsert (a DB write) + banCheckMiddleware's separate SELECT used to cost 2 serial
// Neon HTTP round trips on EVERY /api request. banned is now returned from the same upsert
// (banCheckMiddleware just reads req.user.banned, no DB call), and a short-lived in-memory
// cache skips the upsert entirely on repeat requests from the same user within TTL — bans
// applied via direct DB UPDATE take up to TTL to propagate, which is an accepted tradeoff
// (documented in banCheck.ts) since bans are set manually and rare.
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
        banned?: boolean;
      };
    }
  }
}

interface CachedAuthUser {
  dbUserId: string;
  banned: boolean;
  expiresAt: number;
}

const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_CACHE_MAX_SIZE = 10_000;
const authCache = new Map<string, CachedAuthUser>();

function getCached(uid: string): CachedAuthUser | undefined {
  const entry = authCache.get(uid);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    authCache.delete(uid);
    return undefined;
  }
  return entry;
}

function setCached(uid: string, dbUserId: string, banned: boolean): void {
  if (authCache.size >= AUTH_CACHE_MAX_SIZE && !authCache.has(uid)) {
    // Evict the oldest entry (Map preserves insertion order) to cap memory.
    const oldestKey = authCache.keys().next().value;
    if (oldestKey !== undefined) authCache.delete(oldestKey);
  }
  authCache.set(uid, { dbUserId, banned, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
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

    const cached = getCached(decoded.uid);
    if (cached) {
      req.user = {
        uid: decoded.uid,
        email: decoded.email,
        dbUserId: cached.dbUserId,
        banned: cached.banned,
      };
      next();
      return;
    }

    // Auto-upsert: provision user row on first authenticated request (atomic, no separate SELECT).
    // banned is read back here so banCheckMiddleware doesn't need its own query.
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
      .returning({ id: users.id, banned: users.banned });

    if (dbUser?.id) {
      setCached(decoded.uid, dbUser.id, dbUser.banned ?? false);
    }

    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      dbUserId: dbUser?.id,
      banned: dbUser?.banned ?? false,
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
