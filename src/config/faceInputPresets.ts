// src/config/faceInputPresets.ts
// Presets/media-types that accept a user-supplied real-person face input. Consumed by BOTH
// inputMediaGate (09.2-06 — decides whether to NSFW-scan) and the raw-face deletion in the
// webhook completion path (09.2-04 — decides whether to reap the upload post-archive). Kept in
// one neutral module so neither consumer imports the other.
export const FACE_INPUT_PRESET_IDS = new Set<string>([
  'faceswap', // 09.2 faceswap preset (swap face slot)
  'motion-transfer', // 09.1 Motion Transfer (avatar image slot)
  'viral-motions', // 09.3 Viral Motions (D-04 real-face selfie -> 9.2 gate + raw-face deletion)
  'you-vs-you', // 09.6 real-face selfie -> gated + reaped (chain media_type, wired in Plan 04)
  'kbo-fan-cam', // 09.6 real-face selfie -> gated + reaped (single-shot HappyHorse 'video' media_type)
  'marlon-motion', // 09.6 real-face photo -> gated + reaped (chain / character_replace fallback)
]);

// media_type fallback for face-input detection when preset_id is absent.
export const FACE_INPUT_MEDIA_TYPES = new Set<string>(['faceswap', 'avatar']);
