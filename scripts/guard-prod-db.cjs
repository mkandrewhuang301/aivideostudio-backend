#!/usr/bin/env node
/**
 * Refuses to run when DATABASE_URL points at the production database.
 *
 * Why this exists (2026-07-27): the local .env's DATABASE_URL and the one Railway injects into
 * the aivideostudio-backend service were byte-identical for an unknown length of time — same Neon
 * endpoint, same neondb. There was no dev database. Every local script, spike and "apply to dev"
 * migration ran against live user data without anything saying so. This guard is the tripwire
 * that was missing.
 *
 * Prefixed onto the npm scripts that mutate schema or delete rows. Plain .cjs on purpose: it must
 * run before tsx/tooling and must not itself need a build step.
 *
 * Escape hatch: ALLOW_PROD_DB=1 to proceed deliberately. Type it out each time; never export it
 * into your shell profile, or this file stops meaning anything.
 */

// The production Neon endpoint id. Not a secret (credentials are the secret); this is here so the
// check works even when .env has been repointed and no other signal distinguishes the two.
const PROD_ENDPOINT = 'ep-noisy-bonus-attd9tbz';

const url = process.env.DATABASE_URL || '';

if (!url) {
  console.error('\n  guard-prod-db: DATABASE_URL is not set — refusing to guess.\n');
  process.exit(1);
}

const isProd = url.includes(PROD_ENDPOINT);

if (isProd && process.env.ALLOW_PROD_DB !== '1') {
  const label = process.env.npm_lifecycle_event || 'this script';
  console.error(`
  ┌──────────────────────────────────────────────────────────────────────┐
  │  BLOCKED: ${String(label).padEnd(58)}│
  │                                                                      │
  │  DATABASE_URL points at the PRODUCTION database (${PROD_ENDPOINT}). │
  │  This script mutates schema or deletes rows. It is not safe here.    │
  │                                                                      │
  │  Point .env at a Neon dev branch, or if you genuinely mean it:       │
  │      ALLOW_PROD_DB=1 npm run ${String(label).padEnd(39)}│
  └──────────────────────────────────────────────────────────────────────┘
`);
  process.exit(1);
}

if (isProd) {
  console.error('\n  guard-prod-db: ALLOW_PROD_DB=1 set — proceeding against PRODUCTION.\n');
}
