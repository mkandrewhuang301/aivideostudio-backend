// src/index.ts
import 'dotenv/config';
import express from 'express';
import { config } from './config';
import { healthRouter } from './routes/health';

const app = express();
app.use(express.json());
app.use('/health', healthRouter);

app.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port} (${config.nodeEnv})`);
});

export default app;
