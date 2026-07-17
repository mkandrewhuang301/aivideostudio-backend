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
  r2PublicAssetsBucketName: process.env.R2_PUBLIC_ASSETS_BUCKET_NAME ?? '',
  r2PublicAssetsDomain: process.env.R2_PUBLIC_ASSETS_DOMAIN ?? '',
  r2PublicAssetsAccessKeyId: process.env.R2_PUBLIC_ASSETS_ACCESS_KEY_ID ?? '',
  r2PublicAssetsSecretAccessKey: process.env.R2_PUBLIC_ASSETS_SECRET_ACCESS_KEY ?? '',
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
  // Celebrity-likeness check (AWS Rekognition RecognizeCelebrities) for the upload-driven
  // motion-transfer / ai-influencer presets — blocks animating a real celebrity's face.
  // Defaults OFF (opt-in) since it needs real AWS IAM creds provisioned; unlike hiveScanEnabled
  // (which defaults on), this stays dark until AWS keys exist + it's been tuned.
  celebrityCheckEnabled: process.env.CELEBRITY_CHECK_ENABLED === 'true',
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  // MatchConfidence (0–100) at/above which an uploaded face is treated as a celebrity match.
  celebrityMatchThreshold: parseFloat(process.env.CELEBRITY_MATCH_THRESHOLD ?? '90'),
  // INPUT-media NSFW scan on user face uploads — SEPARATE from the OUTPUT CSAM scan above, and
  // SEPARATE from the Rekognition celebrity gate (celebrityCheckEnabled). Reuses the v3
  // visual-moderation key (hiveApiKey) but has its OWN enable flag, defaulting OFF (opt-in).
  // Age/minor scanning intentionally NOT implemented (D-2). Never couple to hiveScanEnabled.
  hiveInputScanEnabled: process.env.HIVE_INPUT_SCAN_ENABLED === 'true',
  hiveInputNsfwThreshold: Number(process.env.HIVE_INPUT_NSFW_THRESHOLD ?? '0.85'),
} as const;

// Shared by the original dispatch (generations.ts) and retry dispatch (webhooks/replicate.ts)
// so both send Replicate to the same normalized URL.
export function getReplicateWebhookUrl(): string {
  const baseUrl = config.publicBaseUrl.trim().replace(/^["']|["']$/g, '');
  const normalizedBase = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
  return `${normalizedBase}/webhooks/replicate`;
}

// Fal-backed regular Kling v3 image-to-video sends this so Fal's queue calls back at a distinct
// route from Replicate's — mirrors getReplicateWebhookUrl() above.
export function getFalWebhookUrl(): string {
  const baseUrl = config.publicBaseUrl.trim().replace(/^["']|["']$/g, '');
  const normalizedBase = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
  return `${normalizedBase}/webhooks/fal`;
}
