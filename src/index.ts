// src/index.ts
import 'dotenv/config';
import express from 'express';
import { config } from './config';
import { healthRouter } from './routes/health';
import { getFirebaseAdmin } from './firebase';
import { authMiddleware } from './middleware/auth';
import { meRouter } from './routes/me';

// Eagerly initialize Firebase Admin at startup — prevents double-init on concurrent requests
getFirebaseAdmin();

const app = express();
app.use(express.json());

app.use('/health', healthRouter);

app.use('/api', authMiddleware);
app.use('/api/me', meRouter);

app.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port} (${config.nodeEnv})`);
});

export default app;
