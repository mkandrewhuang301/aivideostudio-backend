// src/routes/reports.ts
// POST /api/reports — authenticated, requires valid Firebase JWT + ban check (mounted upstream in index.ts).
// Ownership validation: generation_id must belong to the requesting user.
// Per CONTEXT.md: reason must be one of 'inappropriate_content' | 'suspected_illegal' | 'other'.

import { Router, Request, Response } from 'express';
import { db } from '../db/client';
import { reports } from '../db/schema';
import { sql } from 'drizzle-orm';

export const reportsRouter = Router();

const VALID_REASONS = ['inappropriate_content', 'suspected_illegal', 'other'] as const;
type ReportReason = (typeof VALID_REASONS)[number];

reportsRouter.post('/', async (req: Request, res: Response) => {
  const { generation_id, reason, free_text } = req.body ?? {};
  const firebaseUid = req.user?.uid;
  const dbUserId = req.user?.dbUserId;

  if (!dbUserId || !firebaseUid) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  if (!generation_id || typeof generation_id !== 'string') {
    res.status(400).json({ error: 'generation_id is required', code: 'MISSING_GENERATION_ID' });
    return;
  }

  if (!VALID_REASONS.includes(reason as ReportReason)) {
    res.status(400).json({
      error: `Invalid reason. Must be one of: ${VALID_REASONS.join(', ')}`,
      code: 'INVALID_REASON',
    });
    return;
  }

  try {
    // Ownership check: verify the generation belongs to the requesting user
    const genResult = await db.execute(sql`
      SELECT id FROM generations WHERE id = ${generation_id}::uuid AND user_id = ${dbUserId}::uuid
    `);

    if ((genResult.rows?.length ?? 0) === 0) {
      res.status(403).json({ error: 'Forbidden', code: 'NOT_YOUR_GENERATION' });
      return;
    }

    await db.insert(reports).values({
      generationId: generation_id,
      userId: firebaseUid,
      reason,
      freeText: free_text ?? null,
    });

    res.status(201).json({ message: 'Report received. Thank you.' });
  } catch (err) {
    console.error('[reports] Error saving report:', err);
    res.status(500).json({ error: 'Failed to save report' });
  }
});
