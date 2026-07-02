// src/config.ts

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: requireEnv('DATABASE_URL'),
  redisUrl: requireEnv('REDIS_URL'),
  r2AccountId: requireEnv('R2_ACCOUNT_ID'),
  r2AccessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  r2SecretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  r2BucketName: requireEnv('R2_BUCKET_NAME'),
  r2PublicDomain: process.env.R2_PUBLIC_DOMAIN ?? '',
  firebaseProjectId: requireEnv('FIREBASE_PROJECT_ID'),
  firebaseClientEmail: requireEnv('FIREBASE_CLIENT_EMAIL'),
  firebasePrivateKey: requireEnv('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
  revenueCatWebhookSecret: requireEnv('REVENUECAT_WEBHOOK_SECRET'),
  apnsAuthKey: requireEnv('APNS_PRIVATE_KEY').replace(/\\n/g, '\n'),
  apnsKeyId: requireEnv('APNS_KEY_ID'),
  apnsTeamId: requireEnv('APNS_TEAM_ID'),
  apnsBundleId: requireEnv('APNS_BUNDLE_ID'),
  replicateApiToken: requireEnv('REPLICATE_API_TOKEN'),
  replicateWebhookSecret: requireEnv('REPLICATE_WEBHOOK_SECRET'),
  publicBaseUrl: requireEnv('PUBLIC_BASE_URL'),
  hiveScanEnabled: process.env.HIVE_SCAN_ENABLED !== 'false',
  hiveApiKey: process.env.HIVE_API_KEY ?? '',
  openaiApiKey: requireEnv('OPENAI_API_KEY'),
} as const;
