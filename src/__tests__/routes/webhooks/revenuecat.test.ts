// src/__tests__/routes/webhooks/revenuecat.test.ts
// Unit tests for RevenueCat webhook handler.
// Covers: auth check (PAY-04 security), INITIAL_PURCHASE grant (PAY-01), REFUND idempotency (PAY-04).

// Mock config FIRST — before any module that calls requireEnv() at load time
jest.mock('../../../config', () => ({
  config: {
    revenueCatWebhookSecret: 'test-webhook-secret',
    databaseUrl: 'mock://db',
    redisUrl: 'redis://localhost',
    r2AccountId: 'mock',
    r2AccessKeyId: 'mock',
    r2SecretAccessKey: 'mock',
    r2BucketName: 'mock',
    r2PublicDomain: '',
    firebaseProjectId: 'mock',
    firebaseClientEmail: 'mock@mock.iam.gserviceaccount.com',
    firebasePrivateKey: 'mock-key',
    port: 3000,
    nodeEnv: 'test',
  },
}));

jest.mock('../../../db/client', () => ({
  db: {
    execute: jest.fn(),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../redis/client', () => ({
  redis: {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
  },
}));

jest.mock('../../../services/creditService', () => ({
  grantCredits: jest.fn().mockResolvedValue(undefined),
  clawbackCredits: jest.fn().mockResolvedValue(undefined),
}));

import express from 'express';
import request from 'supertest';
import { revenueCatWebhookRouter } from '../../../routes/webhooks/revenuecat';
import { redis } from '../../../redis/client';
import { db } from '../../../db/client';
import { grantCredits, clawbackCredits } from '../../../services/creditService';

const app = express();
app.use(express.json());
app.use('/webhooks/revenuecat', revenueCatWebhookRouter);

const VALID_AUTH = 'Bearer test-webhook-secret';
const WRONG_AUTH = 'Bearer wrong-secret';

// A DB user row returned on lookup
const USER_ROW = { id: 'db-user-uuid-1' };

// Helper: build a minimal RevenueCat event payload
function makePayload(
  type: string,
  productId = 'com.fantasiaai.basic_monthly',
  transactionId = 'txn-001',
) {
  return {
    event: {
      type,
      app_user_id: 'firebase-uid-1',
      transaction_id: transactionId,
      product_id: productId,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: user found in DB
  (db.execute as jest.Mock).mockResolvedValue({ rows: [USER_ROW] });
  // Default: Redis SET NX returns 'OK' (key is new — not a duplicate)
  (redis.set as jest.Mock).mockResolvedValue('OK');
  // Re-setup default insert mock after clearAllMocks
  (db.insert as jest.Mock).mockReturnValue({
    values: jest.fn().mockResolvedValue(undefined),
  });
});

// ─── Authorization check ─────────────────────────────────────────────────────

describe('Authorization check', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(app)
      .post('/webhooks/revenuecat')
      .send(makePayload('INITIAL_PURCHASE'));
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization header has wrong secret', async () => {
    const res = await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', WRONG_AUTH)
      .send(makePayload('INITIAL_PURCHASE'));
    expect(res.status).toBe(401);
  });

  it('returns 200 when Authorization header is correct', async () => {
    const res = await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('INITIAL_PURCHASE'));
    expect(res.status).toBe(200);
  });
});

// ─── INITIAL_PURCHASE event (PAY-01) ─────────────────────────────────────────

describe('INITIAL_PURCHASE event (PAY-01)', () => {
  it('calls grantCredits with 500 credits for com.fantasiaai.basic_monthly', async () => {
    await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('INITIAL_PURCHASE', 'com.fantasiaai.basic_monthly', 'txn-basic-monthly-001'));

    expect(grantCredits).toHaveBeenCalledWith(
      USER_ROW.id,
      500,
      'subscription_grant',
      'txn-basic-monthly-001',
    );
  });

  it('updates entitlement_level to "basic" for basic_monthly subscription', async () => {
    // First db.execute call: user lookup; second: UPDATE entitlement_level
    (db.execute as jest.Mock)
      .mockResolvedValueOnce({ rows: [USER_ROW] }) // user lookup
      .mockResolvedValueOnce({ rows: [] });         // UPDATE entitlement

    await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('INITIAL_PURCHASE', 'com.fantasiaai.basic_monthly', 'txn-basic-monthly-002'));

    // db.execute called twice: once for user lookup, once for entitlement UPDATE
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('calls grantCredits with 1400 credits for com.fantasiaai.pro_monthly', async () => {
    await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('INITIAL_PURCHASE', 'com.fantasiaai.pro_monthly', 'txn-pro-monthly-001'));

    expect(grantCredits).toHaveBeenCalledWith(
      USER_ROW.id,
      1400,
      'subscription_grant',
      'txn-pro-monthly-001',
    );
  });

  it('calls grantCredits with 5800 credits for com.fantasiaai.creator_monthly', async () => {
    await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('INITIAL_PURCHASE', 'com.fantasiaai.creator_monthly', 'txn-creator-001'));

    expect(grantCredits).toHaveBeenCalledWith(
      USER_ROW.id,
      5800,
      'subscription_grant',
      'txn-creator-001',
    );
  });

  it('returns 200 with skipped:unknown_product for unknown product_id', async () => {
    const res = await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('INITIAL_PURCHASE', 'com.fantasiaai.unknown_plan'));

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('unknown_product');
    expect(grantCredits).not.toHaveBeenCalled();
  });
});

// ─── NON_RENEWING_PURCHASE (top-up) ─────────────────────────────────────────

describe('NON_RENEWING_PURCHASE event (top-up)', () => {
  it('grants 500 credits with 90-day expiry for topup_9_99', async () => {
    await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('NON_RENEWING_PURCHASE', 'com.fantasiaai.topup_9_99', 'txn-topup-001'));

    expect(grantCredits).toHaveBeenCalledWith(
      USER_ROW.id,
      500,
      'topup_grant',
      'txn-topup-001',
      expect.any(Date),
    );
  });

  it('grants 2900 credits for topup_49_99', async () => {
    await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('NON_RENEWING_PURCHASE', 'com.fantasiaai.topup_49_99', 'txn-topup-002'));

    expect(grantCredits).toHaveBeenCalledWith(
      USER_ROW.id,
      2900,
      'topup_grant',
      'txn-topup-002',
      expect.any(Date),
    );
  });

  it('returns skipped:unknown_product for unrecognised top-up product_id', async () => {
    const res = await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('NON_RENEWING_PURCHASE', 'com.fantasiaai.topup_unknown'));

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('unknown_product');
    expect(grantCredits).not.toHaveBeenCalled();
  });
});

// ─── REFUND idempotency (PAY-04) ──────────────────────────────────────────────

describe('REFUND idempotency (PAY-04)', () => {
  it('calls clawbackCredits on first REFUND delivery', async () => {
    (redis.set as jest.Mock).mockResolvedValue('OK'); // New key — not a duplicate

    await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('REFUND', 'com.fantasiaai.basic_monthly', 'txn-refund-001'));

    expect(clawbackCredits).toHaveBeenCalledWith(USER_ROW.id, 500, 'txn-refund-001');
  });

  it('skips clawbackCredits on duplicate REFUND delivery (idempotency)', async () => {
    (redis.set as jest.Mock).mockResolvedValue(null); // Key already exists — duplicate

    const res = await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('REFUND', 'com.fantasiaai.basic_monthly', 'txn-refund-001'));

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(clawbackCredits).not.toHaveBeenCalled();
  });

  it('uses transaction_id as Redis idempotency key', async () => {
    await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('INITIAL_PURCHASE', 'com.fantasiaai.basic_monthly', 'specific-txn-id'));

    expect(redis.set).toHaveBeenCalledWith(
      'rc_webhook:specific-txn-id',
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
  });

  it('clears entitlement_level when REFUND is processed', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce({ rows: [USER_ROW] }) // user lookup
      .mockResolvedValueOnce({ rows: [] });         // UPDATE entitlement = NULL

    await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('REFUND', 'com.fantasiaai.pro_monthly', 'txn-refund-002'));

    // db.execute called twice: user lookup + entitlement clear
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(clawbackCredits).toHaveBeenCalledWith(USER_ROW.id, 1400, 'txn-refund-002');
  });
});

// ─── REFUND for top-up ───────────────────────────────────────────────────────

describe('REFUND for top-up products', () => {
  it('claws back credits when a top-up purchase is refunded', async () => {
    await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('REFUND', 'com.fantasiaai.topup_9_99', 'txn-topup-refund-001'));

    expect(clawbackCredits).toHaveBeenCalledWith(USER_ROW.id, 500, 'txn-topup-refund-001');
  });

  it('does NOT clear entitlement_level when a top-up is refunded (only subscriptions affect entitlement)', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce({ rows: [USER_ROW] }); // user lookup only — no entitlement UPDATE

    await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('REFUND', 'com.fantasiaai.topup_24_99', 'txn-topup-refund-002'));

    expect(clawbackCredits).toHaveBeenCalledWith(USER_ROW.id, 1400, 'txn-topup-refund-002');
    // db.execute called exactly once (user lookup only, no entitlement UPDATE)
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});

// ─── EXPIRATION / CANCELLATION ───────────────────────────────────────────────

describe('EXPIRATION and CANCELLATION events', () => {
  it('clears entitlement_level on EXPIRATION', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce({ rows: [USER_ROW] }) // user lookup
      .mockResolvedValueOnce({ rows: [] });         // UPDATE entitlement = NULL

    const res = await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('EXPIRATION', 'com.fantasiaai.basic_monthly', 'txn-exp-001'));

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(grantCredits).not.toHaveBeenCalled();
    expect(clawbackCredits).not.toHaveBeenCalled();
  });

  it('returns 200 and takes no credit action on CANCELLATION', async () => {
    const res = await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('CANCELLATION', 'com.fantasiaai.basic_monthly', 'txn-cancel-001'));

    expect(res.status).toBe(200);
    expect(grantCredits).not.toHaveBeenCalled();
    expect(clawbackCredits).not.toHaveBeenCalled();
    // Only user lookup, no entitlement UPDATE
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('returns 200 (not 500) when user is not found in DB', async () => {
    // idempotency key is NEW, but user not found
    (db.execute as jest.Mock).mockResolvedValue({ rows: [] }); // user not found

    const res = await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('INITIAL_PURCHASE'));

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('user_not_found');
    expect(grantCredits).not.toHaveBeenCalled();
  });

  it('deletes idempotency key when user is not found (allows RC retry)', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ rows: [] }); // user not found

    await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('INITIAL_PURCHASE', 'com.fantasiaai.basic_monthly', 'txn-retry-key'));

    // Redis del must be called to allow RevenueCat to retry
    expect(redis.del).toHaveBeenCalledWith('rc_webhook:txn-retry-key');
  });

  it('returns 200 for unknown event type without throwing', async () => {
    const res = await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('UNKNOWN_FUTURE_EVENT'));

    expect(res.status).toBe(200);
    expect(grantCredits).not.toHaveBeenCalled();
    expect(clawbackCredits).not.toHaveBeenCalled();
  });

  it('returns 200 even when an unexpected error is thrown (prevents RC retry storm)', async () => {
    // Force an unexpected error inside the handler
    (grantCredits as jest.Mock).mockRejectedValueOnce(new Error('Unexpected DB failure'));
    (db.execute as jest.Mock)
      .mockResolvedValueOnce({ rows: [USER_ROW] }) // user lookup succeeds
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/webhooks/revenuecat')
      .set('Authorization', VALID_AUTH)
      .send(makePayload('INITIAL_PURCHASE', 'com.fantasiaai.basic_monthly', 'txn-error-001'));

    expect(res.status).toBe(200);
    expect(res.body.error).toBe('internal_error');
  });
});
