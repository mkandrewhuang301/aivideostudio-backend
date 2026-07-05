// src/config/presets.ts
//
// Server-driven preset registry — single source of truth for every Home card (Phase 9.1).
// A new preset (or un-SOONing an existing one) ships by editing this file and redeploying;
// no iOS app release is required (SC1). Mirrors the "serve-config-from-backend" pattern
// already used by src/routes/rates.ts.
//
// D-04: SOON tiles are ordinary registry rows (status:'soon') — never hardcoded client UI.
// D-11: `prompt_template` is server-only and must NEVER reach the client. `CLIENT_PRESETS`
//       below is the sanitized projection served by GET /api/presets (see routes/presets.ts).
//
// NOTE on `section` taxonomy: 09.1-CONTEXT.md D-02 (revised 2026-07-05) merged the original
// "Photo Tools" and "Effects" Home sections into a single "Photo" section — the split was
// arbitrary (Anime Yourself/Polaroid are photo tools too, same as Try-On/Hairstyle). This
// registry uses the post-revision 4-section taxonomy (hero | photo | avatar_center |
// shows_vlogs) to match 09.1-06-PLAN.md's Home grouping, which already assumes a single
// merged "Photo" section per that decision.

export const PRESETS_VERSION = 1;

export type PresetSection = 'hero' | 'photo' | 'avatar_center' | 'shows_vlogs';
export type PresetStatus = 'live' | 'soon';
export type PresetBadge = 'NEW' | 'HOT';
export type PresetMediaType = 'video' | 'image' | 'avatar' | 'upscale';

export interface PresetSlot {
  kind: 'image' | 'video';
  label: string;
  source: 'any' | 'my_look_default';
}

export interface PresetTextField {
  label: string;
  required: boolean;
}

export interface PresetStyleOption {
  id: string;
  label: string;
  thumb_url?: string;
}

export interface PresetInputSchema {
  slots: PresetSlot[];
  text?: PresetTextField;
  style_grid?: PresetStyleOption[];
}

export type PresetCost =
  | { type: 'flat'; credits: number }
  | { type: 'per_second'; credits_per_sec: number; max_seconds?: number };

export interface PresetTile {
  poster_url: string;
  loop_url: string;
  aspect?: string;
}

export interface PresetDef {
  preset_id: string;
  title: string;
  subtitle?: string;
  section: PresetSection;
  sort_order: number;
  status: PresetStatus;
  badge?: PresetBadge;
  tile: PresetTile;
  // Everything below only applies to status === 'live':
  media_type?: PresetMediaType;
  model?: string;
  /**
   * SERVER-ONLY. The expanded/interpolated prompt template dispatched to the provider.
   * MUST NEVER be serialized to the client (D-11, threat T-09.1-01) — `CLIENT_PRESETS`
   * strips this field before res.json(). Do not add this field to any client-facing type.
   */
  prompt_template?: string;
  input_schema?: PresetInputSchema;
  // SOON rows carry no cost — nothing is billed until the feature ships.
  cost?: PresetCost;
}

// Dev-generated placeholder art (D-09) — the user produces and delivers final poster/loop
// files for every preset before phase completion; these stable, version-suffixed URLs are
// swapped out server-side with no app release required.
function placeholderTile(presetId: string): PresetTile {
  return {
    poster_url: `https://assets.fantasia.example/presets/${presetId}/poster-v1.jpg`,
    loop_url: `https://assets.fantasia.example/presets/${presetId}/loop-v1.mp4`,
    aspect: '3:4',
  };
}

export const SERVER_PRESETS: PresetDef[] = [
  // ─── Hero ────────────────────────────────────────────────────────────────
  {
    preset_id: 'cinema-studio',
    title: 'Cinema Studio',
    subtitle: 'Coming Soon',
    section: 'hero',
    sort_order: 1,
    status: 'soon',
    tile: { ...placeholderTile('cinema-studio'), aspect: '16:9' },
  },

  // ─── Photo (merged Photo Tools + Effects — D-02 revised 2026-07-05) ───────
  {
    preset_id: 'try-on',
    title: 'AI Try-On',
    section: 'photo',
    sort_order: 1,
    status: 'soon',
    badge: 'NEW',
    tile: placeholderTile('try-on'),
    // UI direction not finalized — see .planning/STATE.md Deferred Items
    // (multi-garment avatar+pins concept vs. extending the existing two-box sheet).
  },
  {
    preset_id: 'hairstyle',
    title: 'Hairstyle',
    section: 'photo',
    sort_order: 2,
    status: 'live',
    media_type: 'image',
    // D-22: presets always call GPT-Image-2 at its 'medium' tier (5 credits) — no
    // quality picker in PresetInputSheet. IMAGE_MODEL_COSTS['openai/gpt-image-2-medium'] = 5.
    model: 'openai/gpt-image-2-medium',
    prompt_template: "Change this person's hairstyle to {style}, keep the face and background unchanged.",
    input_schema: {
      slots: [{ kind: 'image', label: 'Your photo', source: 'any' }],
      style_grid: [
        { id: 'bob', label: 'Bob' },
        { id: 'pixie-cut', label: 'Pixie Cut' },
        { id: 'crew-cut', label: 'Buzz' },
        { id: 'side-swept-bangs', label: 'Curtain Bangs' },
        { id: 'perm', label: 'Perm' },
        { id: 'layered', label: 'Layered' },
        { id: 'slicked-back', label: 'Slicked Back' },
        { id: 'undercut', label: 'Undercut' },
        { id: 'soft-waves', label: 'Soft Waves' },
        { id: 'french-braid', label: 'French Braid' },
        { id: 'box-braids', label: 'Box Braids' },
        { id: 'curly', label: 'Curly' },
      ],
    },
    cost: { type: 'flat', credits: 5 },
    tile: placeholderTile('hairstyle'),
  },
  {
    preset_id: 'enhancer-video',
    title: 'AI Enhance',
    subtitle: 'Video',
    section: 'photo',
    sort_order: 3,
    status: 'live',
    media_type: 'upscale',
    model: 'bytedance/video-upscaler',
    prompt_template: '', // upscale path takes no text prompt
    input_schema: {
      slots: [{ kind: 'video', label: 'Video to enhance', source: 'any' }],
    },
    cost: { type: 'per_second', credits_per_sec: 1 },
    tile: placeholderTile('enhancer-video'),
  },
  {
    preset_id: 'enhancer-image',
    title: 'AI Enhance',
    subtitle: 'Photo',
    section: 'photo',
    sort_order: 4,
    status: 'live',
    media_type: 'upscale',
    model: 'recraft-ai/recraft-crisp-upscale',
    prompt_template: '', // upscale path takes no text prompt
    input_schema: {
      slots: [{ kind: 'image', label: 'Image to enhance', source: 'any' }],
    },
    cost: { type: 'flat', credits: 1 },
    tile: placeholderTile('enhancer-image'),
  },
  {
    preset_id: 'anime-yourself',
    title: 'Anime Yourself',
    section: 'photo',
    sort_order: 5,
    status: 'live',
    media_type: 'image',
    model: 'openai/gpt-image-2-medium', // D-22: medium tier, 5 credits
    prompt_template:
      'Transform this photo into a high-quality anime illustration of the same person, ' +
      'preserving their identity, pose, expression, and outfit, in a vibrant Japanese anime art style.',
    input_schema: {
      slots: [{ kind: 'image', label: 'Your photo', source: 'any' }],
    },
    cost: { type: 'flat', credits: 5 },
    tile: placeholderTile('anime-yourself'),
  },
  {
    preset_id: 'polaroid',
    title: 'Polaroid Hug',
    section: 'photo',
    sort_order: 6,
    status: 'live',
    media_type: 'image',
    model: 'openai/gpt-image-2-medium', // D-22: medium tier, 5 credits
    prompt_template:
      'Composite the two people from the reference photos into a single vintage polaroid-style ' +
      'photograph, warmly hugging each other, soft film grain, warm polaroid color grading, ' +
      'natural lighting, photorealistic, both faces clearly visible and unchanged.',
    input_schema: {
      slots: [
        { kind: 'image', label: 'Person 1', source: 'any' },
        { kind: 'image', label: 'Person 2', source: 'any' },
      ],
    },
    cost: { type: 'flat', credits: 5 },
    tile: placeholderTile('polaroid'),
  },
  {
    preset_id: 'animate-old-photo',
    title: 'Animate Old Photo',
    section: 'photo',
    sort_order: 7,
    status: 'live',
    badge: 'HOT',
    media_type: 'video',
    model: 'bytedance/seedance-2.0-mini',
    prompt_template:
      'Bring this old photo to life with subtle, natural motion — gentle breathing, slight head ' +
      'movement, soft ambient background motion — keep the vintage look and colors intact, no audio.',
    input_schema: {
      slots: [{ kind: 'image', label: 'Old photo', source: 'any' }],
    },
    cost: { type: 'per_second', credits_per_sec: 9, max_seconds: 5 },
    tile: placeholderTile('animate-old-photo'),
  },
  {
    preset_id: 'motion-transfer',
    title: 'Motion Transfer',
    section: 'photo',
    sort_order: 8,
    status: 'live',
    media_type: 'avatar',
    model: 'bytedance/dreamactor-m2.0',
    prompt_template: '', // avatar path uses no text prompt
    input_schema: {
      slots: [
        { kind: 'image', label: 'Your photo', source: 'any' },
        { kind: 'video', label: 'Driving video', source: 'any' },
      ],
    },
    cost: { type: 'per_second', credits_per_sec: 5, max_seconds: 30 },
    tile: placeholderTile('motion-transfer'),
  },
  {
    preset_id: 'faceswap',
    title: 'Faceswap',
    section: 'photo',
    sort_order: 9,
    status: 'soon',
    tile: placeholderTile('faceswap'),
  },

  // ─── Avatar Center ─────────────────────────────────────────────────────────
  {
    preset_id: 'avatar-center',
    title: 'Avatar Center',
    subtitle: 'Your AI twin — coming soon',
    section: 'avatar_center',
    sort_order: 1,
    status: 'soon',
    tile: placeholderTile('avatar-center'),
  },

  // ─── Shows & Vlogs ───────────────────────────────────────────────────────
  {
    preset_id: 'gorilla-vlogs',
    title: 'Gorilla Vlogs',
    section: 'shows_vlogs',
    sort_order: 1,
    status: 'soon',
    tile: placeholderTile('gorilla-vlogs'),
  },
  {
    preset_id: 'fruit-island',
    title: 'Fruit Island',
    section: 'shows_vlogs',
    sort_order: 2,
    status: 'soon',
    tile: placeholderTile('fruit-island'),
  },
];

/**
 * Client-facing projection of SERVER_PRESETS — `prompt_template` deleted before this array
 * is ever touched by a response serializer. GET /api/presets serves this, never SERVER_PRESETS.
 */
export const CLIENT_PRESETS = SERVER_PRESETS.map((def) => {
  const { prompt_template, ...rest } = def;
  return rest;
});
