// src/db/schema.ts
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql, desc } from 'drizzle-orm';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const creditTransactionTypeEnum = pgEnum('credit_transaction_type', [
  'subscription_grant',
  'topup_grant',
  'generation_deduct',
  'generation_refund',
  'refund_clawback',
]);

export const generationStatusEnum = pgEnum('generation_status', [
  'pending',
  'processing',
  'completed',
  'failed',
  'quarantined',
  'refunded',
  'deleted',     // enables soft-delete (D-37, GAL-06)
]);

// ─── users ────────────────────────────────────────────────────────────────────
// Per D-12: id (UUID), firebase_uid (unique), email, credits_balance (integer default 0),
//           created_at, updated_at
// Note: credits_balance is a SIGNED integer (allows negative for bug detection).
//       apns_device_token added here for Phase 4 (APNs) to avoid a future migration.

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    firebase_uid: text('firebase_uid').notNull().unique(),
    email: text('email'),
    credits_balance: integer('credits_balance').notNull().default(0),
    apns_device_token: text('apns_device_token'),
    entitlement_level: text('entitlement_level'), // nullable: 'basic' | 'pro' | NULL (no active subscription)
    subscription_allotment: integer('subscription_allotment').notNull().default(0), // credits granted in the current billing period (reset on RENEWAL)
    revenuecat_customer_id: text('revenuecat_customer_id').unique(), // RevenueCat customer ID — O(1) webhook lookups without joining on firebase_uid
    subscription_product_id: text('subscription_product_id'), // active product_id (e.g. 'com.fantasiaai.basic_yearly'); cleared on REFUND/EXPIRATION
    subscription_started_at: timestamp('subscription_started_at', { withTimezone: true }), // set on INITIAL_PURCHASE; drives anniversary-based credit grants for yearly plans
    display_name: text('display_name'), // user display name for profile UI (Phase 6)
    total_generations: integer('total_generations').notNull().default(0), // incremented on generation completion; avoids COUNT(*) on generations table
    last_active_at: timestamp('last_active_at', { withTimezone: true }), // churn analytics and re-engagement push (Phase 7)
    banned: boolean('banned').notNull().default(false),
    onboarding_preferences: jsonb('onboarding_preferences'), // nullable jsonb; saved after auth from bubble-picker onboarding (Phase 6)
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    firebaseUidIdx: uniqueIndex('users_firebase_uid_idx').on(table.firebase_uid),
  }),
);

// ─── credit_transactions ──────────────────────────────────────────────────────
// Per D-13: append-only ledger. id, user_id, amount (positive=credit, negative=debit),
//           type (enum), reference_id (fal request ID, RevenueCat transaction ID, etc.),
//           created_at
// NEVER update or delete rows from this table.

export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id),
    amount: integer('amount').notNull(), // positive = credit, negative = debit
    type: creditTransactionTypeEnum('type').notNull(),
    reference_id: text('reference_id'), // Replicate prediction_id, RevenueCat transaction_id, etc.
    expires_at: timestamp('expires_at', { withTimezone: true }), // nullable; set only for topup_grant rows (90-day expiry from purchase date)
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userIdIdx: index('credit_transactions_user_id_idx').on(table.user_id),
    createdAtIdx: index('credit_transactions_created_at_idx').on(table.created_at),
  }),
);

// ─── generations ──────────────────────────────────────────────────────────────
// Per D-14: id (UUID), user_id, replicate_prediction_id (unique, nullable until dispatched),
//           model (varchar), status (enum), prompt, params (jsonb),
//           cost_credits (integer), r2_key (nullable), created_at, completed_at
// IMPORTANT: replicate_prediction_id must have a unique index to prevent duplicate webhook processing.

export const generations = pgTable(
  'generations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id),
    replicate_prediction_id: text('replicate_prediction_id').unique(), // nullable until dispatched; unique prevents duplicate webhook processing
    model: text('model').notNull(), // e.g. 'bytedance/seedance-2.0-fast'
    status: generationStatusEnum('status').notNull().default('pending'),
    prompt: text('prompt'),
    params: jsonb('params'), // {resolution, duration, aspect_ratio, audio_enabled, ref_asset_key}
    cost_credits: integer('cost_credits').notNull(),
    r2_key: text('r2_key'), // nullable until video archived to R2
    media_type: text('media_type').notNull().default('video'), // 'video' | 'image'; validated at application layer (prepareCost middleware)
    failure_reason: text('failure_reason'), // nullable; 'content_policy' | 'copyright' | 'generic_error' | 'provider_error' — set when status transitions to 'failed'
    retry_count: integer('retry_count').notNull().default(0), // bumped on transient-provider-error auto-retry (webhooks/replicate.ts); capped at 1
    is_favorite: boolean('is_favorite').notNull().default(false), // FAV-01: user-toggled favorite flag, display-only server state
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    userIdIdx: index('generations_user_id_idx').on(table.user_id),
    statusIdx: index('generations_status_idx').on(table.status),
    createdAtIdx: index('generations_created_at_idx').on(table.created_at),
    replicatePredictionIdUniqueIdx: uniqueIndex('generations_replicate_prediction_id_unique_idx').on(
      table.replicate_prediction_id,
    ),
    // Perf: covers the hottest query — listGenerations filters user_id and orders by
    // created_at DESC, id DESC (keyset pagination). Without this, Postgres can use
    // generations_user_id_idx but must still sort the user's rows for the ORDER BY.
    userCreatedIdx: index('generations_user_created_idx').on(
      table.user_id,
      desc(table.created_at),
      desc(table.id),
    ),
  }),
);

// ─── reference_uploads ────────────────────────────────────────────────────────
// Persistent record of user-uploaded reference media. R2 objects do not expire;
// presigned URLs are generated fresh at query time (GET /api/uploads).

export const referenceUploads = pgTable(
  'reference_uploads',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    user_id: uuid('user_id').notNull().references(() => users.id),
    r2_key: text('r2_key').notNull(),
    mime_type: text('mime_type').notNull(), // 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4'
    display_name: text('display_name'), // nullable; user-assigned name shown as [name] token in prompt
    created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    userIdIdx: index('reference_uploads_user_id_idx').on(table.user_id),
    createdAtIdx: index('reference_uploads_created_at_idx').on(table.created_at),
  }),
);

// ─── reports ──────────────────────────────────────────────────────────────────
// Phase 5: User-submitted content reports. References generations.id and users.firebase_uid.

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    generationId: uuid('generation_id')
      .references(() => generations.id)
      .notNull(),
    userId: text('user_id')
      .references(() => users.firebase_uid)
      .notNull(),
    reason: text('reason').notNull(), // 'inappropriate_content' | 'suspected_illegal' | 'other'
    freeText: text('free_text'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    generationIdIdx: index('reports_generation_id_idx').on(table.generationId),
    userIdIdx: index('reports_user_id_idx').on(table.userId),
  }),
);

// ─── Type exports (used by services in Phases 2–5) ───────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type CreditTransaction = typeof creditTransactions.$inferSelect;
export type NewCreditTransaction = typeof creditTransactions.$inferInsert;
export type Generation = typeof generations.$inferSelect;
export type NewGeneration = typeof generations.$inferInsert;
export type GenerationStatus = (typeof generationStatusEnum.enumValues)[number];
export type CreditTransactionType = (typeof creditTransactionTypeEnum.enumValues)[number];
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type ReferenceUpload = typeof referenceUploads.$inferSelect;
export type NewReferenceUpload = typeof referenceUploads.$inferInsert;
