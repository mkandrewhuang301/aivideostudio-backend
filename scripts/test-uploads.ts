// Bypasses config.ts — only needs DATABASE_URL from .env
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql, desc } from 'drizzle-orm';

const sql_ = neon(process.env.DATABASE_URL!);
const db = drizzle(sql_);

const referenceUploads = pgTable('reference_uploads', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  user_id: uuid('user_id').notNull(),
  r2_key: text('r2_key').notNull(),
  mime_type: text('mime_type').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => ({ createdAtIdx: index('reference_uploads_created_at_idx').on(t.created_at) }));

const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  firebase_uid: text('firebase_uid').notNull(),
});

async function main() {
  console.log('\n=== reference_uploads rows ===');
  const rows = await db.select().from(referenceUploads).orderBy(desc(referenceUploads.created_at)).limit(20);
  if (rows.length === 0) {
    console.log('EMPTY — POST /api/uploads is not inserting rows (old backend still deployed or insert failing)');
  } else {
    for (const r of rows) {
      console.log(`  user=${r.user_id}  mime=${r.mime_type}  created=${r.created_at}`);
      console.log(`  key=${r.r2_key}`);
    }
  }

  console.log('\n=== users (first 3) ===');
  const us = await db.select().from(users).limit(3);
  for (const u of us) console.log(`  id=${u.id}  firebase=${u.firebase_uid}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
