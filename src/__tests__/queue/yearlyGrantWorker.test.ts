jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    removeRepeatable: jest.fn().mockResolvedValue(true),
  })),
  Worker: jest.fn().mockImplementation(() => ({ close: jest.fn(), on: jest.fn() })),
}));

jest.mock('../../db/client', () => ({ db: { execute: jest.fn() } }));
jest.mock('../../redis/client', () => ({ redis: { set: jest.fn() } }));
jest.mock('../../services/creditService', () => ({ grantCredits: jest.fn() }));

import { db } from '../../db/client';
import { redis } from '../../redis/client';
import { grantCredits } from '../../services/creditService';
import {
  grantYearlyMonthlyCredits,
  scheduleYearlyGrant,
  yearlyGrantQueue,
  currentMonthKey,
  getTodayGrantDay,
} from '../../queue/yearlyGrantWorker';

const mockExecute = db.execute as jest.Mock;
const mockRedisSet = redis.set as jest.Mock;
const mockGrantCredits = grantCredits as jest.Mock;

beforeEach(() => jest.clearAllMocks());

// ─── getTodayGrantDay — anniversary / month-end logic ────────────────────────

describe('getTodayGrantDay', () => {
  it('returns the correct day for a normal mid-month date', () => {
    expect(getTodayGrantDay(new Date('2026-03-15T00:00:00Z'))).toEqual({
      day: 15,
      isMonthEnd: false,
      lastDayOfMonth: 31,
    });
  });

  it('marks January 31 as month-end (31-day month)', () => {
    expect(getTodayGrantDay(new Date('2026-01-31T00:00:00Z'))).toEqual({
      day: 31,
      isMonthEnd: true,
      lastDayOfMonth: 31,
    });
  });

  it('does NOT mark January 30 as month-end', () => {
    expect(getTodayGrantDay(new Date('2026-01-30T00:00:00Z'))).toEqual({
      day: 30,
      isMonthEnd: false,
      lastDayOfMonth: 31,
    });
  });

  it('does NOT mark January 29 as month-end', () => {
    expect(getTodayGrantDay(new Date('2026-01-29T00:00:00Z'))).toEqual({
      day: 29,
      isMonthEnd: false,
      lastDayOfMonth: 31,
    });
  });

  it('marks June 30 as month-end (30-day month)', () => {
    expect(getTodayGrantDay(new Date('2026-06-30T00:00:00Z'))).toEqual({
      day: 30,
      isMonthEnd: true,
      lastDayOfMonth: 30,
    });
  });

  it('does NOT mark June 29 as month-end', () => {
    expect(getTodayGrantDay(new Date('2026-06-29T00:00:00Z'))).toEqual({
      day: 29,
      isMonthEnd: false,
      lastDayOfMonth: 30,
    });
  });

  it('marks February 28 as month-end in a non-leap year', () => {
    expect(getTodayGrantDay(new Date('2026-02-28T00:00:00Z'))).toEqual({
      day: 28,
      isMonthEnd: true,
      lastDayOfMonth: 28,
    });
  });

  it('does NOT mark February 28 as month-end in a leap year', () => {
    expect(getTodayGrantDay(new Date('2028-02-28T00:00:00Z'))).toEqual({
      day: 28,
      isMonthEnd: false,
      lastDayOfMonth: 29,
    });
  });

  it('marks February 29 as month-end in a leap year', () => {
    expect(getTodayGrantDay(new Date('2028-02-29T00:00:00Z'))).toEqual({
      day: 29,
      isMonthEnd: true,
      lastDayOfMonth: 29,
    });
  });

  it('handles December 31 (year boundary) correctly', () => {
    expect(getTodayGrantDay(new Date('2026-12-31T00:00:00Z'))).toEqual({
      day: 31,
      isMonthEnd: true,
      lastDayOfMonth: 31,
    });
  });

  it('handles April 30 as month-end (30-day month)', () => {
    expect(getTodayGrantDay(new Date('2026-04-30T00:00:00Z'))).toEqual({
      day: 30,
      isMonthEnd: true,
      lastDayOfMonth: 30,
    });
  });

  it('does NOT mark April 29 as month-end', () => {
    expect(getTodayGrantDay(new Date('2026-04-29T00:00:00Z'))).toEqual({
      day: 29,
      isMonthEnd: false,
      lastDayOfMonth: 30,
    });
  });

  // A user who subscribed on Feb 29 (leap year) must get granted on Feb 28 in non-leap years.
  // getTodayGrantDay on Feb 28 non-leap returns lastDayOfMonth=28, isMonthEnd=true,
  // so the SQL condition `isMonthEnd AND subscription_day (29) > lastDayOfMonth (28)` fires.
  it('Feb 28 non-leap: isMonthEnd=true with lastDayOfMonth=28 — covers leap-day subscribers', () => {
    expect(getTodayGrantDay(new Date('2026-02-28T00:00:00Z'))).toEqual({
      day: 28,
      isMonthEnd: true,
      lastDayOfMonth: 28,
    });
    // A subscriber with subscription day=29 satisfies: 29 > 28, so they get granted today.
    // A subscriber with subscription day=30 satisfies: 30 > 28, so they get granted today.
    // A subscriber with subscription day=31 satisfies: 31 > 28, so they get granted today.
  });
});

// ─── grantYearlyMonthlyCredits ───────────────────────────────────────────────

describe('grantYearlyMonthlyCredits', () => {
  it('grants credits to all yearly subscribers using the correct monthly amount', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        { id: 'user-1', subscription_product_id: 'com.fantasiaai.basic_yearly' },
        { id: 'user-2', subscription_product_id: 'com.fantasiaai.pro_yearly' },
        { id: 'user-3', subscription_product_id: 'com.fantasiaai.creator_yearly' },
      ],
    });
    mockRedisSet.mockResolvedValue('OK'); // NX succeeds for all

    await grantYearlyMonthlyCredits();

    expect(mockGrantCredits).toHaveBeenCalledTimes(3);
    expect(mockGrantCredits).toHaveBeenCalledWith('user-1', 500,  'subscription_grant', expect.stringContaining('user-1'));
    expect(mockGrantCredits).toHaveBeenCalledWith('user-2', 1400, 'subscription_grant', expect.stringContaining('user-2'));
    expect(mockGrantCredits).toHaveBeenCalledWith('user-3', 5800, 'subscription_grant', expect.stringContaining('user-3'));
  });

  it('skips a user when Redis NX fails — already granted this month', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ id: 'user-1', subscription_product_id: 'com.fantasiaai.basic_yearly' }],
    });
    mockRedisSet.mockResolvedValue(null); // NX fails — key already exists

    await grantYearlyMonthlyCredits();

    expect(mockGrantCredits).not.toHaveBeenCalled();
  });

  it('grants for users where NX succeeds and skips those where it fails', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        { id: 'user-already', subscription_product_id: 'com.fantasiaai.basic_yearly' },
        { id: 'user-new',     subscription_product_id: 'com.fantasiaai.pro_yearly' },
      ],
    });
    mockRedisSet
      .mockResolvedValueOnce(null) // user-already: NX fails
      .mockResolvedValueOnce('OK'); // user-new: NX succeeds

    await grantYearlyMonthlyCredits();

    expect(mockGrantCredits).toHaveBeenCalledTimes(1);
    expect(mockGrantCredits).toHaveBeenCalledWith('user-new', 1400, 'subscription_grant', expect.any(String));
  });

  it('uses a Redis key scoped to the user and current calendar month', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ id: 'user-1', subscription_product_id: 'com.fantasiaai.basic_yearly' }],
    });
    mockRedisSet.mockResolvedValue('OK');

    await grantYearlyMonthlyCredits();

    const monthKey = currentMonthKey();
    expect(mockRedisSet).toHaveBeenCalledWith(
      `yearly_monthly_grant:user-1:${monthKey}`,
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
  });

  it('does nothing when no yearly subscribers exist', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    await grantYearlyMonthlyCredits();

    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockGrantCredits).not.toHaveBeenCalled();
  });

  it('uses a 35-day TTL on the idempotency key to outlast any calendar month', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ id: 'user-1', subscription_product_id: 'com.fantasiaai.basic_yearly' }],
    });
    mockRedisSet.mockResolvedValue('OK');

    await grantYearlyMonthlyCredits();

    const [, , , ttl] = mockRedisSet.mock.calls[0];
    expect(ttl).toBeGreaterThanOrEqual(35 * 24 * 60 * 60);
  });

  it('skips rows with an unrecognised subscription_product_id without throwing', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ id: 'user-1', subscription_product_id: 'com.fantasiaai.unknown_yearly' }],
    });

    await grantYearlyMonthlyCredits();

    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockGrantCredits).not.toHaveBeenCalled();
  });
});

// ─── scheduleYearlyGrant ─────────────────────────────────────────────────────

describe('scheduleYearlyGrant', () => {
  it('removes the old monthly cron before adding the daily one', async () => {
    await scheduleYearlyGrant();

    expect(yearlyGrantQueue.removeRepeatable).toHaveBeenCalledWith(
      'grant',
      { pattern: '0 0 1 * *' },
    );
  });

  it('schedules a daily cron at UTC midnight with singleton jobId', async () => {
    await scheduleYearlyGrant();

    expect(yearlyGrantQueue.add).toHaveBeenCalledWith(
      'grant',
      {},
      { repeat: { pattern: '0 0 * * *' }, jobId: 'yearly-grant-singleton' },
    );
  });

  it('removes the old job before adding the new one', async () => {
    const callOrder: string[] = [];
    (yearlyGrantQueue.removeRepeatable as jest.Mock).mockImplementation(() => {
      callOrder.push('remove');
      return Promise.resolve(true);
    });
    (yearlyGrantQueue.add as jest.Mock).mockImplementation(() => {
      callOrder.push('add');
      return Promise.resolve();
    });

    await scheduleYearlyGrant();

    expect(callOrder).toEqual(['remove', 'add']);
  });
});
