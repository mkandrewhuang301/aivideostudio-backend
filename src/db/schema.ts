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
  doublePrecision,
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
    face_consent_at: timestamp('face_consent_at', { withTimezone: true }), // SC2: set once on first-use face-input consent attestation; NULL = not yet consented
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
    kind: text('kind').notNull().default('reference'), // 'reference' | 'look' | 'mask' (mask = internal Magic Editor alpha, hidden from GET /uploads); plain text (app-validated), not pgEnum — avoids extra push round-trip (08-01 pattern)
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

// ─── projects (Phase 13: Edit Studio) ─────────────────────────────────────────
// Per D-01/D-02: a project is a real, persistent, structured entity (not a one-shot
// render). Multiple concurrent projects per user allowed — no single-active constraint.

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title'), // nullable; app-side default "Untitled Project"
    aspect_ratio: text('aspect_ratio').notNull().default('9:16'), // '9:16' | '4:5' | '1:1' | '16:9' — app-validated
    thumbnail_r2_key: text('thumbnail_r2_key'), // nullable
    caption_style: jsonb('caption_style'), // {fontSize, color, highlightColor, positionYNorm, position} — ONE global style per SC5
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    userIdIdx: index('projects_user_id_idx').on(table.user_id),
    // Perf: covers the project hub's listing query (filter user_id, ORDER BY created_at DESC, id DESC)
    // — mirrors the generations_user_created_idx covering-index convention.
    userCreatedIdx: index('projects_user_created_idx').on(
      table.user_id,
      desc(table.created_at),
      desc(table.id),
    ),
  }),
);

// ─── project_clips (Phase 13: Edit Studio) ────────────────────────────────────
// Ordered clip list per project. Per D-03: imported by COPY, not reference — r2_key
// is an independent object, unaffected if the source generation/upload is later deleted.

export const projectClips = pgTable(
  'project_clips',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    sort_order: integer('sort_order').notNull(),
    r2_key: text('r2_key').notNull(), // independent COPY per D-03
    media_type: text('media_type').notNull(), // 'video' | 'image'
    source_type: text('source_type').notNull(), // 'generation' | 'upload' — provenance only, NOT a live FK
    original_duration_seconds: integer('original_duration_seconds'), // nullable
    trim_start_seconds: integer('trim_start_seconds').notNull().default(0),
    trim_end_seconds: integer('trim_end_seconds'), // nullable
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    projectIdIdx: index('project_clips_project_id_idx').on(table.project_id),
  }),
);

// ─── project_text_overlays (Phase 13: Edit Studio) ────────────────────────────
// Draggable Text overlays — normalized 0..1 position, fixed single style (no font/color
// picker in v1, per 13-RESEARCH.md Open Question 2 resolution).

export const projectTextOverlays = pgTable(
  'project_text_overlays',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    text: text('text').notNull(),
    x_norm: doublePrecision('x_norm'), // 0..1 normalized position
    y_norm: doublePrecision('y_norm'), // 0..1 normalized position
    width_norm: doublePrecision('width_norm'), // nullable
    start_seconds: doublePrecision('start_seconds').notNull(),
    end_seconds: doublePrecision('end_seconds').notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    projectIdIdx: index('project_text_overlays_project_id_idx').on(table.project_id),
  }),
);

// ─── project_audio_clips (Phase 13: Edit Studio) ──────────────────────────────
// Multi-clip Audio track (LOCKED per 13-RESEARCH.md Open Question 1 resolution — supports
// narration + music both landing as separate pills, e.g. AI Autoexplainer smart-unpack D-15).

export const projectAudioClips = pgTable(
  'project_audio_clips',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    r2_key: text('r2_key').notNull(),
    source_type: text('source_type').notNull().default('upload'), // 'upload' | 'preset' | 'narration'
    start_offset_seconds: doublePrecision('start_offset_seconds').notNull().default(0), // position on the assembled project timeline
    trim_start_seconds: doublePrecision('trim_start_seconds').notNull().default(0),
    trim_end_seconds: doublePrecision('trim_end_seconds'), // nullable
    sort_order: integer('sort_order').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    projectIdIdx: index('project_audio_clips_project_id_idx').on(table.project_id),
  }),
);

// ─── project_caption_cues (Phase 13: Edit Studio) ─────────────────────────────
// A "cue" = one displayed line/phrase on the Captions track (distinct from Text overlays).

export const projectCaptionCues = pgTable(
  'project_caption_cues',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    sort_order: integer('sort_order').notNull(),
    start_seconds: doublePrecision('start_seconds').notNull(),
    end_seconds: doublePrecision('end_seconds').notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    projectIdIdx: index('project_caption_cues_project_id_idx').on(table.project_id),
  }),
);

// ─── project_caption_words (Phase 13: Edit Studio) ────────────────────────────
// Per-word cues — matches the exact {text, start, end} shape Phase 14's AI Autoexplainer
// smart-unpack writes into directly (D-15/D-16), no translation layer needed.

export const projectCaptionWords = pgTable(
  'project_caption_words',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    cue_id: uuid('cue_id')
      .notNull()
      .references(() => projectCaptionCues.id),
    text: text('text').notNull(),
    start_seconds: doublePrecision('start_seconds').notNull(),
    end_seconds: doublePrecision('end_seconds').notNull(),
    sort_order: integer('sort_order').notNull(),
  },
  (table) => ({
    cueIdIdx: index('project_caption_words_cue_id_idx').on(table.cue_id),
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
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectClip = typeof projectClips.$inferSelect;
export type NewProjectClip = typeof projectClips.$inferInsert;
export type ProjectTextOverlay = typeof projectTextOverlays.$inferSelect;
export type NewProjectTextOverlay = typeof projectTextOverlays.$inferInsert;
export type ProjectAudioClip = typeof projectAudioClips.$inferSelect;
export type NewProjectAudioClip = typeof projectAudioClips.$inferInsert;
export type ProjectCaptionCue = typeof projectCaptionCues.$inferSelect;
export type NewProjectCaptionCue = typeof projectCaptionCues.$inferInsert;
export type ProjectCaptionWord = typeof projectCaptionWords.$inferSelect;
export type NewProjectCaptionWord = typeof projectCaptionWords.$inferInsert;
