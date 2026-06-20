// src/redis/client.ts
import Redis from 'ioredis';
import { config } from '../config';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: false,
});

redis.on('error', (err) => console.error('[Redis] connection error:', err));
redis.on('connect', () => console.log('[Redis] connected'));
