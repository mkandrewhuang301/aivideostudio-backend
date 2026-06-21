// src/db/client.ts
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { config } from '../config';
import * as schema from './schema';

const sql = neon(config.databaseUrl);
export const db = drizzle(sql, { schema });
