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
  deviceCheckPrivateKey: (process.env.DEVICE_CHECK_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
  deviceCheckKeyId: process.env.DEVICE_CHECK_KEY_ID ?? '',
  deviceCheckTeamId: process.env.DEVICE_CHECK_TEAM_ID ?? '',
  freeCreditBundle: parseInt(process.env.FREE_CREDIT_BUNDLE ?? '5', 10),
  replicateApiToken: requireEnv('REPLICATE_API_TOKEN'),
  replicateWebhookSecret: requireEnv('REPLICATE_WEBHOOK_SECRET'),
  publicBaseUrl: requireEnv('PUBLIC_BASE_URL'),
  // Policy v2: output scanning is sanctioned only for rows whose persisted
  // has_real_face_input flag is true. Defaults OFF until the scoped production rollout is
  // intentionally enabled; the old global HIVE_SCAN_ENABLED switch is retired.
  hiveScanRealFacePaths: process.env.HIVE_SCAN_REAL_FACE_PATHS === 'true',
  hiveApiKey: process.env.HIVE_API_KEY ?? '',
  // Separate Moderation Dashboard application mapped to Hive's Combined CSAM/Thorn API.
  // When absent, the tuned visual combiner still runs but hash matching is not active.
  hiveCsamApiKey: process.env.HIVE_CSAM_API_KEY ?? '',
  hiveLowChildThreshold: Number(process.env.HIVE_LOW_CHILD_THRESHOLD ?? '0.80'),
  hiveLowSexualThreshold: Number(process.env.HIVE_LOW_SEXUAL_THRESHOLD ?? '0.70'),
  openaiApiKey: requireEnv('OPENAI_API_KEY'),
  // Long-video semantic planning for AutoSummary. Optional at process boot so deployments that
  // have not enabled the feature still start; the summary worker fails/refunds clearly if absent.
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  // Magic Editor image-edit provider. Nano Banana (Gemini 3.1 Flash Image) is ~4x cheaper than
  // gpt-image-2 and edits more surgically (2026-07-23 bakeoff). Default 'nano'; set to 'openai'
  // for a no-deploy rollback to the previous /v1/images/edits path.
  magicEditorProvider: process.env.MAGIC_EDITOR_PROVIDER ?? 'nano',
  nanoImageModel: process.env.NANO_IMAGE_MODEL ?? 'gemini-3.1-flash-image-preview',
  // Native Gemini audio is materially cheaper than Fal's wrappers. Both APIs are preview, so
  // these switches provide a no-deploy rollback and an automatic provider fallback.
  googleNativeAudioEnabled: process.env.GOOGLE_NATIVE_AUDIO_ENABLED !== 'false',
  googleAudioFalFallbackEnabled: process.env.GOOGLE_AUDIO_FAL_FALLBACK_ENABLED !== 'false',
  // Cloud Text-to-Speech (texttospeech.googleapis.com) is GA with production quotas and hosts the
  // same Chirp3-HD voices (Kore etc.) as the preview interactions endpoint — the primary TTS path,
  // free of the AI-Studio preview rate limit. Enabled by default; set false to fall back to the
  // interactions/Fal chain. Auth prefers CLOUD_TTS_API_KEY (simplest from Railway); with no key it
  // uses Application Default Credentials (the attached service account on Cloud Run).
  cloudTtsEnabled: process.env.CLOUD_TTS_ENABLED !== 'false',
  cloudTtsApiKey: process.env.CLOUD_TTS_API_KEY ?? '',
  cloudTtsVoice: process.env.CLOUD_TTS_VOICE ?? 'en-US-Chirp3-HD-Kore',
  // qwen3-tts (Replicate) is the single narration engine (2026-07-23 TTS strategy): cheapest, and
  // the only one that clones. Cloud TTS above is now dormant last-resort insurance behind it. When
  // a narration call carries a qwen voice config, qwen is used; on qwen failure it falls back to
  // the Cloud-TTS/interactions/Fal chain. Toggle off to force the old chain.
  qwenTtsEnabled: process.env.QWEN_TTS_ENABLED !== 'false',
  falTtsFallbackModel: process.env.FAL_TTS_FALLBACK_MODEL ?? 'fal-ai/gemini-3.1-flash-tts',
  falLyriaFallbackModel: process.env.FAL_LYRIA_FALLBACK_MODEL ?? 'fal-ai/lyria2',
  videoSummaryModel: process.env.VIDEO_SUMMARY_MODEL ?? 'gemini-3.5-flash',
  // Bounded text-only narration audit. Flash-Lite is intentionally separate from the full-video
  // planner so the additional reliability pass costs substantially less than another video pass.
  videoSummaryTextModel: process.env.VIDEO_SUMMARY_TEXT_MODEL ?? 'gemini-3.5-flash-lite',
  // Direct Wikipedia lookup is cheap and fail-open. Set false for an emergency external-network
  // kill switch; timestamped source-evidence planning continues unchanged when disabled.
  videoSummaryWikipediaEnabled: process.env.VIDEO_SUMMARY_WIKIPEDIA_ENABLED !== 'false',
  // Gemini Omni video generation runs through the Gemini Enterprise Agent Platform
  // Interactions endpoint. Keep this separate from firebaseProjectId: Firebase Auth lives in a
  // different Google project, while Agent Platform billing belongs to Fantasia's credit project.
  agentPlatformProjectId: process.env.AGENT_PLATFORM_PROJECT_ID ?? 'fantasia-503112',
  agentPlatformClientEmail: process.env.AGENT_PLATFORM_CLIENT_EMAIL ?? '',
  agentPlatformPrivateKey: (process.env.AGENT_PLATFORM_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
  // AI Music remains dark until the 18+ eligibility/compliance gate is enabled in production.
  aiMusicEnabled: process.env.AI_MUSIC_ENABLED === 'true',
  aiMusicProvider: process.env.AI_MUSIC_PROVIDER ?? 'lyria',
  aiMusicClipModel: process.env.LYRIA_CLIP_MODEL ?? 'lyria-3-clip-preview',
  aiMusicProModel: process.env.LYRIA_PRO_MODEL ?? 'lyria-3-pro-preview',
  aiMusicMaxDurationSeconds: Number(process.env.AI_MUSIC_MAX_DURATION_SECONDS ?? '184'),
  aiMusicWorkerConcurrency: Number(process.env.AI_MUSIC_WORKER_CONCURRENCY ?? '2'),
  aiMusicRequestsPerMinute: Number(process.env.AI_MUSIC_REQUESTS_PER_MINUTE ?? '8'),
  aiMusicAnalysisModel: process.env.AI_MUSIC_ANALYSIS_MODEL ?? 'gemini-3.1-flash-lite',
  aiMusicAnalysisFrameCount: Number(process.env.AI_MUSIC_ANALYSIS_FRAME_COUNT ?? '5'),
  // Celebrity-likeness check (AWS Rekognition RecognizeCelebrities) for the upload-driven
  // motion-transfer / ai-influencer presets — blocks animating a real celebrity's face.
  // Defaults OFF (opt-in) since it needs real AWS IAM creds provisioned; this stays dark until
  // AWS keys exist and the matching has been tuned.
  celebrityCheckEnabled: process.env.CELEBRITY_CHECK_ENABLED === 'true',
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  // MatchConfidence (0–100) at/above which an uploaded face is treated as a celebrity match.
  celebrityMatchThreshold: parseFloat(process.env.CELEBRITY_MATCH_THRESHOLD ?? '90'),
  // INPUT-media NSFW scan on user face uploads — SEPARATE from the OUTPUT CSAM scan above, and
  // SEPARATE from the Rekognition celebrity gate (celebrityCheckEnabled). Reuses the v3
  // visual-moderation key (hiveApiKey) but has its OWN enable flag, defaulting OFF (opt-in).
  // Age/minor scanning intentionally NOT implemented (D-2). Never couple this to the scoped
  // output-scan switch.
  hiveInputScanEnabled: process.env.HIVE_INPUT_SCAN_ENABLED === 'true',
  hiveInputNsfwThreshold: Number(process.env.HIVE_INPUT_NSFW_THRESHOLD ?? '0.85'),
  // NCMEC CyberTipline Reporting API. Credentials are issued only after ESP registration.
  // Keep the base URL overridable so the official exttest environment can be used before prod.
  ncmecEspUsername: process.env.NCMEC_ESP_USERNAME ?? '',
  ncmecEspPassword: process.env.NCMEC_ESP_PASSWORD ?? '',
  ncmecReporterEmail: process.env.NCMEC_REPORTER_EMAIL ?? process.env.ABUSE_CONTACT_EMAIL ?? '',
  ncmecApiBaseUrl: process.env.NCMEC_API_BASE_URL ?? 'https://report.cybertip.org/ispws',
  abuseContactEmail: process.env.ABUSE_CONTACT_EMAIL ?? '',
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
