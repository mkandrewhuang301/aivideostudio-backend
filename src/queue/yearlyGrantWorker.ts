// src/queue/yearlyGrantWorker.ts
// BullMQ repeatable job — runs daily at UTC midnight.
// Grants one month of subscription credits to yearly subscribers whose subscription
// anniversary falls on today (month-end users granted on the last day of shorter months).
// Uses Redis NX per user per calendar month to prevent double-granting with
// the RevenueCat INITIAL_PURCHASE/RENEWAL webhook handlers.

import { Queue, Worker } from 'bullmq';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { redis } from '../redis/client';
import { grantCredits } from '../services/creditService';

const QUEUE_NAME = 'yearly-grant';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export const yearlyGrantQueue = new Queue(QUEUE_NAME, { connection: connectionOptions });

const YEARLY_PRODUCT_CREDITS: Record<string, number> = {
  'com.fantasiaai.basic_yearly':   500,
  'com.fantasiaai.pro_yearly':     1400,
  'com.fantasiaai.creator_yearly': 5800,
};

const MONTHLY_GRANT_TTL_SECONDS = 35 * 24 * 60 * 60;

export function currentMonthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Returns the day-of-month to match against subscription_started_at, plus whether
// today is the last day of the month (needed to cover subscribers on the 29th/30th/31st
// in shorter months).
export function getTodayGrantDay(now: Date = new Date()): { day: number; isMonthEnd: boolean; lastDayOfMonth: number } {
  const day = now.getUTCDate();
  // new Date(UTC year, month+1, 0) gives the last day of the current month
  const lastDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return { day, isMonthEnd: day === lastDayOfMonth, lastDayOfMonth };
}

export async function grantYearlyMonthlyCredits(): Promise<void> {
  // Capture now once so getTodayGrantDay and currentMonthKey can't straddle midnight.
  const now = new Date();
  const { day, isMonthEnd, lastDayOfMonth } = getTodayGrantDay(now);

  const result = await db.execute(sql`
    SELECT id, subscription_product_id
    FROM users
    WHERE subscription_product_id IN (
      'com.fantasiaai.basic_yearly',
      'com.fantasiaai.pro_yearly',
      'com.fantasiaai.creator_yearly'
    )
    AND subscription_started_at IS NOT NULL
    AND (
      EXTRACT(DAY FROM subscription_started_at) = ${day}
      OR (${isMonthEnd} AND EXTRACT(DAY FROM subscription_started_at) > ${lastDayOfMonth})
    )
  `);

  const monthKey = currentMonthKey(now);

  for (const row of (result.rows ?? []) as Array<{ id: string; subscription_product_id: string }>) {
    const credits = YEARLY_PRODUCT_CREDITS[row.subscription_product_id];
    if (!credits) continue;

    const idempotencyKey = `yearly_monthly_grant:${row.id}:${monthKey}`;
    const isNew = await redis.set(idempotencyKey, '1', 'EX', MONTHLY_GRANT_TTL_SECONDS, 'NX');
    if (!isNew) {
      console.log(`[yearlyGrant] ${row.id} already granted for ${monthKey} — skipping`);
      continue;
    }

    const referenceId = `yearly-monthly-${row.id}-${monthKey}`;
    await grantCredits(row.id, credits, 'subscription_grant', referenceId);
    console.log(`[yearlyGrant] Granted ${credits} credits to user ${row.id} for ${monthKey}`);
  }
}

export async function scheduleYearlyGrant(): Promise<void> {
  // Remove the old monthly cron (0 0 1 * *) left over from Phase 4.
  // Safe to call even if the job is already gone — returns false, doesn't throw.
  await yearlyGrantQueue.removeRepeatable('grant', { pattern: '0 0 1 * *' });
  await yearlyGrantQueue.add(
    'grant',
    {},
    { repeat: { pattern: '0 0 * * *' }, jobId: 'yearly-grant-singleton' },
  );
}

export const yearlyGrantWorker = new Worker(
  QUEUE_NAME,
  async () => { await grantYearlyMonthlyCredits(); },
  { connection: connectionOptions, concurrency: 1 },
);
