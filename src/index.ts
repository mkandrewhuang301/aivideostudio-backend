// src/index.ts
import 'dotenv/config';
import express from 'express';
import { config } from './config';
import { healthRouter } from './routes/health';
import { getFirebaseAdmin } from './firebase';
import { authMiddleware } from './middleware/auth';
import { meRouter } from './routes/me';
import { revenueCatWebhookRouter } from './routes/webhooks/revenuecat';
import { replicateWebhookRouter } from './routes/webhooks/replicate';
import { generationsRouter } from './routes/generations';
import { scheduleReaper } from './queue/reaperWorker';
import { scheduleUploadReaper } from './queue/uploadReaperWorker';
import { scheduleYearlyGrant } from './queue/yearlyGrantWorker';
import './queue/hiveScanWorker';
import './queue/openaiGenerationWorker';
import './queue/chainGenerationWorker';
import './queue/influencerProWorker';
import './queue/ffmpegWorker';
import { banCheckMiddleware } from './middleware/banCheck';
import { reportsRouter } from './routes/reports';
import { uploadsRouter } from './routes/uploads';
import { privacyRouter } from './routes/privacy';
import { termsRouter } from './routes/terms';
import { ratesRouter } from './routes/rates';
import { presetsRouter } from './routes/presets';

// Eagerly initialize Firebase Admin at startup — prevents double-init on concurrent requests
getFirebaseAdmin();

// Schedule the BullMQ reaper once at startup (Redis persists the repeat schedule across restarts;
// jobId: 'reaper-singleton' inside scheduleReaper() prevents duplicate schedules on redeploy).
scheduleReaper().catch((err) => console.error('[server] Failed to schedule reaper:', err));
scheduleUploadReaper().catch((err) => console.error('[server] Failed to schedule upload reaper:', err));
scheduleYearlyGrant().catch((err) => console.error('[server] Failed to schedule yearly grant:', err));

// Hive CSAM scanning defaults on; HIVE_SCAN_ENABLED=false disables it deliberately.
// Logged at startup so a missing/misconfigured env var doesn't silently disable scanning.
console.log(`[server] Hive CSAM scanning: ${config.hiveScanEnabled ? 'ENABLED' : 'DISABLED'}`);

const app = express();

// CRITICAL (RESEARCH.md Pitfall 1): Replicate webhook needs the RAW body for validateWebhook()
// signature verification. Must be registered BEFORE the global express.json() call below —
// otherwise express.json() parses req.body into an object and validateWebhook() silently fails.
app.use(
  '/webhooks/replicate',
  express.raw({ type: 'application/json' }),
  replicateWebhookRouter,
);

app.use(express.json());

app.use('/health', healthRouter);

// RevenueCat webhook — OUTSIDE the /api auth gate below, no Firebase JWT required
// (server-to-server). RevenueCat authenticates with the Authorization Bearer header
// set in the RC dashboard, verified inside revenueCatWebhookRouter itself.
//
// Mounted at BOTH paths: the RC dashboard was historically configured with an
// `/api/` prefix (see .planning/phases/03-credit-infrastructure/03-VERIFICATION.md)
// which doesn't match this router's canonical path and caused all webhook events to
// 404 in production — meaning purchases/renewals/refunds never credited accounts.
// Mounting both paths here (before the /api auth gate) makes delivery correct
// regardless of which URL is actually saved in the RC dashboard.
app.use('/webhooks/revenuecat', revenueCatWebhookRouter);
app.use('/api/webhooks/revenuecat', revenueCatWebhookRouter);

// Public preset registry — mounted under /api/presets but BEFORE the /api auth gate below
// (Express matches middleware by registration order, not path nesting depth) so it stays
// public like ratesRouter, per 09.1-01-PLAN.md's explicit /api/presets mount instruction.
app.use('/api/presets', presetsRouter);

app.use('/api', authMiddleware, banCheckMiddleware);
app.use('/api/me', meRouter);
app.use('/api/generations', generationsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/uploads', uploadsRouter);

app.use('/privacy', privacyRouter);
app.use('/terms', termsRouter);
app.use('/rates', ratesRouter);

app.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port} (${config.nodeEnv})`);
});

export default app;
