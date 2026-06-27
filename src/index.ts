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
import { banCheckMiddleware } from './middleware/banCheck';
import { reportsRouter } from './routes/reports';
import { privacyRouter } from './routes/privacy';

// Eagerly initialize Firebase Admin at startup — prevents double-init on concurrent requests
getFirebaseAdmin();

// Schedule the BullMQ reaper once at startup (Redis persists the repeat schedule across restarts;
// jobId: 'reaper-singleton' inside scheduleReaper() prevents duplicate schedules on redeploy).
scheduleReaper().catch((err) => console.error('[server] Failed to schedule reaper:', err));

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

// RevenueCat webhook — OUTSIDE /api, no Firebase JWT required (server-to-server).
// RevenueCat authenticates with Authorization Bearer header set in RC dashboard.
app.use('/webhooks/revenuecat', revenueCatWebhookRouter);

app.use('/api', authMiddleware, banCheckMiddleware);
app.use('/api/me', meRouter);
app.use('/api/generations', generationsRouter);
app.use('/api/reports', reportsRouter);

app.use('/privacy', privacyRouter);

app.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port} (${config.nodeEnv})`);
});

export default app;
