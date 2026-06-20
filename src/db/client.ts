// src/db/client.ts
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { config } from '../config';

const sql = neon(config.databaseUrl);
export const db = drizzle(sql);
