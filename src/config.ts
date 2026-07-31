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
  // VLM quality judge for explainer stills (2026-07-25): gemini-3.6-flash via the native
  // generativelanguage API using geminiApiKey (2.5-flash deprecated 2026-06-17 — do NOT regress).
  // Upgraded 3.5→3.6 on 2026-07-31: same $1.50 input, $7.50 vs $9 output, ~17% fewer output
  // tokens (~31% cheaper per task, ~half task time, flat AA composite). Key spiked 2026-07-31.
  // Fail-open everywhere; enabled-flag is the no-deploy kill switch.
  imageJudgeEnabled: process.env.IMAGE_JUDGE_ENABLED !== 'false',
  imageJudgeModel: process.env.IMAGE_JUDGE_MODEL ?? 'gemini-3.6-flash',
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
  // Character-vlog expansion pass (2026-07-25). Default sonnet-5/effort-low: the cheap pick,
  // claude-3.5-haiku, 500'd consistently on Replicate at build time (upstream INTERNAL even on
  // trivial prompts) — flip back via env once it recovers. ~$0.005/beat, covered by 6cr/s.
  vlogExpansionModel: process.env.VLOG_EXPANSION_MODEL ?? 'anthropic/claude-sonnet-5',
  falTtsFallbackModel: process.env.FAL_TTS_FALLBACK_MODEL ?? 'fal-ai/gemini-3.1-flash-tts',
  falLyriaFallbackModel: process.env.FAL_LYRIA_FALLBACK_MODEL ?? 'fal-ai/lyria2',
  videoSummaryModel: process.env.VIDEO_SUMMARY_MODEL ?? 'gemini-3.6-flash', // 3.5→3.6 2026-07-31 (same input price, cheaper/faster output; keeps video input)
  // Prompt intelligence (2026-07-30): gpt-5-mini → GPT-5.6 Luna after the 80% Luna price cut
  // ($0.20/$1.20 vs mini's $0.25/$2.00 per 1M). Env-overridable for no-deploy A/B and instant
  // rollback — set PROMPT_INTEL_MODEL / PROMPT_INTERCEPTOR_MODEL back to 'gpt-5-mini' to revert.
  // Spike-verified 2026-07-30 against the live API: model id 'gpt-5.6-luna' is valid, BUT Luna
  // does not support reasoning_effort 'minimal' (supported: none/low/medium/high/xhigh) — a
  // mini-style 'minimal' call 400s. Interceptor default 'low': the 2026-07-30 spike series
  // (8 prompts x none/low/medium) found low = the quality sweet spot (medium adds reasoning
  // spend with flat-to-worse output on short creative rewrites). When rolling the model back
  // to gpt-5-mini, set the effort env back to 'minimal' to match.
  promptIntelligenceModel: process.env.PROMPT_INTEL_MODEL ?? 'gpt-5.6-luna',
  promptInterceptorModel: process.env.PROMPT_INTERCEPTOR_MODEL ?? 'gpt-5.6-luna',
  promptInterceptorReasoningEffort: process.env.PROMPT_INTERCEPTOR_REASONING_EFFORT ?? 'low',
  // Continuation guide (POST /api/prompt/from-video, 2026-07-25): Gemini is the only model in
  // the stack that takes actual VIDEO input (gpt-5-mini/nano are text+image only). Short clips
  // go inline after a 480p downscale — whole clip is 3-8s, no trimming needed.
  videoGuideModel: process.env.VIDEO_GUIDE_MODEL ?? 'gemini-3.6-flash',
  // Bounded text-only narration audit. Flash-Lite is intentionally separate from the full-video
  // planner so the additional reliability pass costs substantially less than another video pass.
  videoSummaryTextModel: process.env.VIDEO_SUMMARY_TEXT_MODEL ?? 'gemini-3.5-flash-lite',
  // Direct Wikipedia lookup is cheap and fail-open. Set false for an emergency external-network
  // kill switch; timestamped source-evidence planning continues unchanged when disabled.
  videoSummaryWikipediaEnabled: process.env.VIDEO_SUMMARY_WIKIPEDIA_ENABLED !== 'false',
  // "Let the clip breathe" diegetic-audio beat (2026-07-25 spec): lets the LLM mark AT MOST ONE
  // beat where the original footage audio plays at full volume and the narrator stays silent.
  // Defaults OFF (ships both behaviors) — off means the planner prompt never invites it AND
  // validateGroundedNarration ignores any audio_mode the model returns anyway, so a recap is
  // byte-identical to today's all-narrated pipeline until this is explicitly turned on.
  videoSummaryDiegeticEnabled: process.env.VIDEO_SUMMARY_DIEGETIC_ENABLED === 'true',
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
  aiMusicAnalysisModel: process.env.AI_MUSIC_ANALYSIS_MODEL ?? 'gemini-3.5-flash-lite', // 3.1-lite→3.5-lite 2026-07-31 (current-gen lite, $0.30/$2.50, 350 tok/s; key spiked)
  aiMusicAnalysisFrameCount: Number(process.env.AI_MUSIC_ANALYSIS_FRAME_COUNT ?? '5'),
  // Phase 20.1 (Audio Separation) — Meta SAM Audio via fal.ai, behind AudioSeparationProvider.
  // audioSepCreditsPerSecond is CONFIRMED (Plan 20.1-02 Task 3, 2026-07-26): two real
  // fal-ai/sam-audio/separate calls (10.0s + 26.64s clips, requests 019f9f84-689c-7432-
  // 9b72-8a00dbbaec47 / 019f9f84-8767-7fc1-89cc-3e0927116350) confirmed reranking_candidates:1 +
  // output_format:'mp3' are accepted and the endpoint returns exactly ONE `duration` field per
  // call matching the input clip length (10.0 / 26.64) with `billable_units: 1.0` identical on
  // both calls — supporting single-billing-per-clip, not per-stem. fal's REST billing ledger
  // (`cost`/`cost_estimate_nano_usd` on GET https://rest.alpha.fal.ai/requests/{id}) stayed
  // `PENDING`/`null` after ~3.5 minutes of live polling (async billing reconciliation lag on
  // fal's side, not independently observable from this shell without dashboard/browser access) —
  // the exact prorated $ delta was NOT numerically re-derived in this session. The rate below is
  // kept at the previously-published fal price ($0.05/30s prorated, 1 reranking candidate =
  // 0.00167 $/s => 0.167 credits/s) per DECISIONS.md §2, now backed by a real, successful,
  // correctly-pinned/single-billed API call rather than the documentation alone. See
  // 20.1-02-SUMMARY.md for full detail; re-verify the exact cents figure on the fal dashboard
  // (Usage/Billing page) if a materially different actual charge is ever observed.
  // Default ON once the iOS Separate-audio tool ships — opt out with AUDIO_SEP_ENABLED=false.
  // (Was === 'true', which left production silently 503'ing every create while the sheet showed 0 credits.)
  audioSepEnabled: process.env.AUDIO_SEP_ENABLED !== 'false',
  audioSepModel: process.env.AUDIO_SEP_MODEL ?? 'fal-ai/sam-audio/separate',
  audioSepCreditsPerSecond: Number(process.env.AUDIO_SEP_CREDITS_PER_SECOND ?? '0.167'),
  audioSepWorkerConcurrency: Number(process.env.AUDIO_SEP_WORKER_CONCURRENCY ?? '2'),
  audioSepRequestsPerMinute: Number(process.env.AUDIO_SEP_REQUESTS_PER_MINUTE ?? '8'),
  audioSepDailyRateLimitPerUser: Number(process.env.AUDIO_SEP_DAILY_RATE_LIMIT_PER_USER ?? '50'),

  // Phase 20.2 (Video Background Removal) — Bria VRMBG 3.0 via fal.ai, behind
  // VideoBackgroundRemovalProvider.
  //
  // PRICING: fal quotes bria/video/background-removal/v3 at $0.0042 per second (confirmed by
  // Andrew from the model page, 2026-07-30). Per the credit rule (credits = provider cost in
  // cents, rounded up) that is 0.42 credits/second: a 10s clip = ceil(4.2) = 5 credits, a 60s
  // clip = 26. Note the OLDER non-v3 endpoint (bria/video/background-removal) is listed at
  // $0.14/s — 33× more. If VIDEO_BG_REMOVAL_MODEL is ever repointed at a non-v3 endpoint,
  // VIDEO_BG_REMOVAL_CREDITS_PER_SECOND MUST be repriced in the same change.
  //
  // Defaults OFF: the iOS "Remove background" button does not exist yet, and the transparent
  // (alpha) output path has not been played back on a real device. Flip
  // VIDEO_BG_REMOVAL_ENABLED=true to open it.
  videoBgRemovalEnabled: process.env.VIDEO_BG_REMOVAL_ENABLED === 'true',
  videoBgRemovalModel: process.env.VIDEO_BG_REMOVAL_MODEL ?? 'bria/video/background-removal/v3',
  videoBgRemovalCreditsPerSecond: Number(process.env.VIDEO_BG_REMOVAL_CREDITS_PER_SECOND ?? '0.42'),
  // Guards a per-second-billed provider against a runaway 20-minute upload.
  videoBgRemovalMaxDurationSeconds: Number(process.env.VIDEO_BG_REMOVAL_MAX_DURATION_SECONDS ?? '180'),
  videoBgRemovalWorkerConcurrency: Number(process.env.VIDEO_BG_REMOVAL_WORKER_CONCURRENCY ?? '2'),
  videoBgRemovalRequestsPerMinute: Number(process.env.VIDEO_BG_REMOVAL_REQUESTS_PER_MINUTE ?? '8'),
  videoBgRemovalDailyRateLimitPerUser: Number(process.env.VIDEO_BG_REMOVAL_DAILY_RATE_LIMIT_PER_USER ?? '30'),
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
