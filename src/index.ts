// src/index.ts
import 'dotenv/config';
import express from 'express';
import { config } from './config';
import { healthRouter } from './routes/health';
import { getFirebaseAdmin } from './firebase';
import { authMiddleware } from './middleware/auth';
import { meRouter } from './routes/me';
import { revenueCatWebhookRouter } from './routes/webhooks/revenuecat';

// Eagerly initialize Firebase Admin at startup — prevents double-init on concurrent requests
getFirebaseAdmin();

const app = express();
app.use(express.json());

app.use('/health', healthRouter);

// RevenueCat webhook — OUTSIDE /api, no Firebase JWT required (server-to-server).
// RevenueCat authenticates with Authorization Bearer header set in RC dashboard.
app.use('/webhooks/revenuecat', revenueCatWebhookRouter);

app.use('/api', authMiddleware);
app.use('/api/me', meRouter);

app.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port} (${config.nodeEnv})`);
});

export default app;
