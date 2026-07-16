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
// NOTE on `section` taxonomy: 09.1-CONTEXT.md D-02 was first revised 2026-07-05 to merge
// "Photo Tools" and "Effects" into a single "Photo" section (that split felt arbitrary), then
// revised again 2026-07-06 to split by OUTPUT media type instead: "Video Effects" (presets that
// produce a video) and "Photo Effects" (presets that produce a still image), video section first.
// This is a different axis than the original tools-vs-effects split — see D-02 in CONTEXT.md.

export const PRESETS_VERSION = 1;

export type PresetSection = 'hero' | 'video_effects' | 'photo_effects' | 'avatar_center' | 'shows_vlogs';
export type PresetStatus = 'live' | 'soon';
export type PresetBadge = 'NEW' | 'HOT';
export type PresetMediaType = 'video' | 'image' | 'avatar' | 'upscale' | 'character_replace' | 'faceswap' | 'chain';

export interface PresetSlot {
  kind: 'image' | 'video';
  label: string;
  source: 'any' | 'my_look_default';
  // Absent/false = required (default, preserves every pre-existing preset's behavior).
  // true = the client may submit this slot empty (null) — see presetResolver's sparse-slot
  // handling for media_type 'image' (Clothes Swap, 09.1-11).
  optional?: boolean;
}

export interface PresetTextField {
  label: string;
  required: boolean;
}

export interface PresetStyleOption {
  id: string;
  label: string;
  // UI grid preview AND (when present) the actual reference image sent to the model alongside
  // the user's own photo — see presetResolver.ts's style-reference handling.
  thumb_url?: string;
  // Client-side filter only (PresetInputSheet "Feminine / Masculine / All" chip) — never used
  // server-side, no auto-detection from the user's photo (deliberate: see 2026-07-07 notes/
  // hairstyle-preset-style-images-gender-filter.md for why).
  gender_tag?: 'feminine' | 'masculine' | 'unisex';
  /**
   * SERVER-ONLY (09.3, D-04). Bundled DreamActor driving-video clip (R2/public URL) paired with
   * this style option — e.g. viral motion packs, where the driving video is a bundled server
   * asset rather than a second user-uploaded slot. Never reaches the client — `CLIENT_PRESETS`
   * strips it from every `input_schema.style_grid` entry.
   */
  driving_video_url?: string;
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

/**
 * Server-driven copy/options for the redesigned PresetInputSheet (Higgsfield-style layout).
 * Optional so existing SOON rows (and any future preset) can omit it entirely. Editable without
 * an app release — same "serve-config-from-backend" rationale as the rest of this registry.
 */
export interface PresetSheetMeta {
  /** Long descriptive sentence rendered under the title on the sheet. */
  description?: string;
  /** Selectable aspect-ratio chips (e.g. GPT-Image-2 presets). Omit => no selector, fixed caption instead. */
  aspect_ratios?: string[];
  /** Must be a member of `aspect_ratios` — the chip pre-selected on open. */
  default_aspect_ratio?: string;
  /** Fixed-aspect display copy for input-driven presets, e.g. "Matches your video". */
  aspect_label?: string;
  /** Fixed, display-only duration caption, e.g. "5s" / "Up to 30s". */
  duration_label?: string;
  /** Fixed, display-only resolution caption, e.g. "720p". */
  resolution_label?: string;
  /**
   * CLIENT-SAFE (09.3, D-05). Caption shown above the Generate bar while the request is
   * submitting, for presets with a server-side pre-processing step the user should know is
   * happening (e.g. LLM script expansion) — e.g. "Writing your script…". Unlike every other
   * field on `PresetDef` prefixed SERVER-ONLY above, this one MUST reach `CLIENT_PRESETS`.
   */
  preparing_label?: string;
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
  /**
   * SERVER-ONLY, same rules as `prompt_template`. Used instead of `prompt_template` when the
   * resolved style_grid option carries a `thumb_url` — that image is sent to the model as a
   * second reference alongside the user's own photo, so this template describes two images
   * instead of one. Falls back to `prompt_template` when the style has no reference image.
   */
  prompt_template_with_reference?: string;
  /**
   * SERVER-ONLY. Bundled visual examples prepended to an image preset's user-uploaded slots.
   * The array order is load-bearing because prompt_template may refer to the examples first and
   * the user's actual subject photos last. These private R2 keys are never serialized to iOS;
   * presetResolver signs them just-in-time for provider dispatch.
   */
  fixed_reference_keys?: string[];
  /**
   * SERVER-ONLY (09.3, D-03/D-05). R2/public URL of the bundled canonical character still image
   * (e.g. the gorilla vlogger) — injected server-side into `reference_images`, ahead of any user
   * upload slots. Never reaches the client (CLIENT_PRESETS strips it).
   */
  character_asset?: string;
  /**
   * SERVER-ONLY (09.3, D-05). When true, presetResolver runs the user's free-text `text` field
   * through `openaiScriptService.expandScript()` (fail-open to `dialogue_prompt_template`/
   * `prompt_template` with `{script}` substituted) before dispatch.
   */
  script_expansion?: boolean;
  /**
   * SERVER-ONLY (09.3, D-05). Dialogue-specific template (may include `{script}`) used as the
   * expandScript fail-open fallback and, for the primary path, the framing template the LLM
   * output is dispatched as. Falls back to `prompt_template` when absent.
   */
  dialogue_prompt_template?: string;
  /**
   * SERVER-ONLY (09.3). Post-processing stamp (ffmpeg mux/concat) merged onto the generation
   * row's `params.postprocess` by presetResolver/generations.ts — read by the webhook to decide
   * whether to enqueue the ffmpeg worker instead of marking the generation complete immediately.
   * Never reaches the client.
   */
  postprocess?: { op: 'mux' | 'concat'; audio_r2_key?: string };
  /**
   * SERVER-ONLY (09.6, D-01/D-05). The chained-job pipeline descriptor for `media_type: 'chain'`
   * presets — the SOLE 9.6 consumer is You vs You (UVU): `image_stage` composes N keyframes
   * (Wan 2.7 Image, model-generic lookup — see `computeChainCost`), `animate_stage` is
   * HappyHorse-1.1-only (the Kling motion-control path was dropped; Marlon ships single-shot).
   * Never reaches the client — `CLIENT_PRESETS` strips this field entirely (D-11, T-09.6-08).
   */
  chain?: {
    image_stage: { model: string; quality: 'high' | 'medium' | 'low'; prompts: string[] };
    animate_stage: { model: string; resolution: '720p' | '1080p'; duration: number; aspect_ratio: string; prompt_template: string };
  };
  /**
   * SERVER-ONLY (09.6, D-03). Bundled driver clip (R2 key) for single-shot `character_replace`
   * presets that pair a bundled driving video with the user's ONE photo slot (Marlon Motion
   * Transfer) rather than requiring the user to upload their own driving video (ai-influencer's
   * shape, unchanged). presetResolver injects this URL into `character_replace_video`; the user's
   * slot[0] becomes `character_replace_image`. Never reaches the client (CLIENT_PRESETS strips it).
   */
  driver_video_asset?: string;
  /**
   * SERVER-ONLY provenance (09.3, D-02). Pre-routes `req.body.model` before dispatch:
   * - 'grok': known real-face preset — skip the doomed Seedance attempt, dispatch straight to
   *   the config-driven `PERMISSIVE_I2V_MODEL` (Grok 1.5).
   * - 'seedance': known-fictional preset — leave `def.model` (Seedance) as-is; best quality.
   * - 'try_seedance_fallback_grok': freeform/unknown — dispatch Seedance as declared; the
   *   webhook's content_policy fallback branch (09.3-03) handles the Grok redispatch on block.
   * Never reaches the client.
   */
  i2v_routing?: 'seedance' | 'grok' | 'try_seedance_fallback_grok';
  input_schema?: PresetInputSchema;
  // SOON rows carry no cost — nothing is billed until the feature ships.
  cost?: PresetCost;
  // Sheet copy/options for the redesigned PresetInputSheet — optional, live rows only.
  sheet?: PresetSheetMeta;
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
    preset_id: 'edit-studio',
    title: 'Edit Studio',
    subtitle: 'Coming Soon',
    section: 'hero',
    sort_order: 1,
    status: 'soon',
    // Renamed from 'cinema-studio' (2026-07-13) — repurposed as the hero card for the
    // upcoming in-app CapCut-style editor (Phase 13: Edit Studio), not the deprioritized
    // Anime Studio concept the old name implied.
    tile: { ...placeholderTile('edit-studio'), aspect: '16:9' },
  },

  // ─── Video Effects (output = video — D-02 revised 2026-07-06, above Photo Effects) ─
  {
    preset_id: 'animate-old-photo',
    title: 'Animate Old Photo',
    section: 'video_effects',
    sort_order: 1,
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
    sheet: {
      description:
        'Bring an old photo to life with gentle, natural motion — soft breathing, subtle head ' +
        'movement, and ambient motion in the background.',
      aspect_label: 'Matches your photo',
      duration_label: '5s',
      resolution_label: '720p',
    },
    tile: placeholderTile('animate-old-photo'),
  },
  {
    preset_id: 'motion-transfer',
    title: 'Motion Transfer',
    section: 'video_effects',
    sort_order: 2,
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
    sheet: {
      description:
        'Upload a photo and a driving video — your photo comes to life, moving and expressing ' +
        'just like the video.',
      aspect_label: 'Matches your video',
      duration_label: 'Up to 30s',
      // No resolution_label: DreamActor's output resolution follows the input photo/video
      // (480x480–1920x1080 per Replicate's schema) rather than a fixed value — a caption here
      // would be misleading. Deviation from the plan's literal bucket list, called out in the
      // final report.
    },
    tile: placeholderTile('motion-transfer'),
  },
  {
    preset_id: 'enhancer-video',
    title: 'AI Enhance',
    subtitle: 'Video',
    section: 'video_effects',
    sort_order: 3,
    status: 'live',
    media_type: 'upscale',
    model: 'bytedance/video-upscaler',
    prompt_template: '', // upscale path takes no text prompt
    input_schema: {
      slots: [{ kind: 'video', label: 'Video to enhance', source: 'any' }],
    },
    cost: { type: 'per_second', credits_per_sec: 1 },
    sheet: {
      description: 'Sharpen and upscale any video for a cleaner, higher-quality result.',
      aspect_label: 'Matches your video',
      // duration_label: "Matches your video" (not "Up to 30s") — this preset's cost has no
      // `max_seconds` cap (it bills the video's real, full duration), unlike Motion Transfer /
      // AI Influencer. Deviation from the plan's literal bucket list, called out in the final
      // report — "Up to 30s" would have been factually wrong for this preset.
      duration_label: 'Matches your video',
      resolution_label: '720p',
    },
    tile: placeholderTile('enhancer-video'),
  },
  {
    // AI Influencer (D-23, added 2026-07-06): "replace" mode — the user's own video's
    // background/motion/lighting is KEPT, the character image replaces the person in it.
    // Inverse framing from Motion Transfer above (which keeps the PHOTO's background).
    // v1 is upload-your-own-character-photo only; a curated/bundled avatar picker is deferred
    // until avatar art exists (09.1-CONTEXT.md D-23).
    preset_id: 'ai-influencer',
    title: 'AI Influencer',
    subtitle: 'Become someone else',
    section: 'video_effects',
    sort_order: 4,
    status: 'live',
    badge: 'NEW',
    media_type: 'character_replace',
    model: 'wan-video/wan-2.2-animate-replace',
    prompt_template: '', // replace path uses no text prompt
    input_schema: {
      slots: [
        { kind: 'video', label: 'Your video', source: 'any' },
        { kind: 'image', label: 'Choose your character', source: 'any' },
      ],
    },
    // $0.05/sec at 720p — user-confirmed 2026-07-06 from Replicate's own pricing criteria for
    // this model ("target resolution is 720, $0.05 per second of output video, or 20s for $1").
    // max_seconds: 30 matches Motion Transfer's DreamActor cap (same 5 credits/sec rate).
    cost: { type: 'per_second', credits_per_sec: 5, max_seconds: 30 },
    sheet: {
      description:
        'Replace yourself with any character in your own video — the motion, lighting, and ' +
        'background stay exactly the same.',
      aspect_label: 'Matches your video',
      duration_label: 'Up to 30s',
      resolution_label: '720p', // ReplicateProvider pins resolution: '720' for this model
    },
    tile: placeholderTile('ai-influencer'),
  },
  {
    // Viral Motions (09.3 SC4/D-04): bundled DreamActor driving videos × the user's single
    // selfie — "you perform the viral move." One Home card + a style_grid inside the sheet
    // (Dance/Runway/Fight v1) rather than one card per motion. The driving video is a bundled
    // server asset PAIRED PER STYLE OPTION (`driving_video_url`), not a second user-uploaded
    // slot like Motion Transfer's driving-video slot — presetResolver's 'avatar' case already
    // prefers a style-bundled driving video over slotUrls[1] (09.3-05).
    preset_id: 'viral-motions',
    title: 'Viral Motions',
    section: 'video_effects',
    sort_order: 5,
    status: 'live',
    badge: 'HOT',
    media_type: 'avatar',
    model: 'bytedance/dreamactor-m2.0',
    prompt_template: '', // avatar path uses no text prompt
    input_schema: {
      slots: [{ kind: 'image', label: 'Your photo', source: 'any' }],
      // TODO(art): placeholder driving-video URLs — replace with the real bundled DreamActor
      // motion-pack clips via `npm run upload:preset-art` once delivered (D-09).
      style_grid: [
        {
          id: 'dance',
          label: 'Dance',
          driving_video_url: 'https://assets.fantasia.example/presets/viral-motions/dance-v1.mp4',
        },
        {
          id: 'runway',
          label: 'Runway',
          driving_video_url: 'https://assets.fantasia.example/presets/viral-motions/runway-v1.mp4',
        },
        {
          id: 'fight',
          label: 'Fight',
          driving_video_url: 'https://assets.fantasia.example/presets/viral-motions/fight-v1.mp4',
        },
      ],
    },
    // Same DreamActor per_second rate as Motion Transfer (computeDreamActorCost — 5 credits/sec).
    cost: { type: 'per_second', credits_per_sec: 5, max_seconds: 30 },
    sheet: {
      description: 'Upload one selfie, pick a motion — you perform the viral move.',
      aspect_label: 'Matches your photo',
      duration_label: 'Up to 30s',
      // No resolution_label — DreamActor's output resolution follows the input, same rationale
      // as Motion Transfer above.
    },
    tile: placeholderTile('viral-motions'),
  },
  {
    // Camera Moves (09.3 SC5): style_grid pack — cinematic camera motion applied to a single
    // uploaded photo. Freeform/unknown user photo → try-Seedance-first, fall back to Grok 1.5 on
    // a content-policy block (D-02's 'try_seedance_fallback_grok' provenance, handled by the
    // webhook's existing 09.3-03 fallback branch — never a pre-classifier here).
    preset_id: 'camera-moves',
    title: 'Camera Moves',
    section: 'video_effects',
    sort_order: 6,
    status: 'live',
    badge: 'NEW',
    media_type: 'video',
    model: 'bytedance/seedance-2.0-mini',
    i2v_routing: 'try_seedance_fallback_grok',
    prompt_template:
      'Animate this photo with a cinematic {style} camera move — smooth, professional camera ' +
      'motion around the subject, keep the subject and background otherwise unchanged, no audio.',
    input_schema: {
      slots: [{ kind: 'image', label: 'Your photo', source: 'any' }],
      style_grid: [
        { id: 'orbit', label: 'Orbit' },
        { id: 'dolly-in', label: 'Dolly In' },
        { id: 'crane-up', label: 'Crane Up' },
        { id: 'whip-pan', label: 'Whip Pan' },
      ],
    },
    cost: { type: 'per_second', credits_per_sec: 9, max_seconds: 5 },
    sheet: {
      description: 'Upload a photo — cinematic camera motion brings it to life.',
      aspect_label: 'Matches your photo',
      duration_label: '5s',
      resolution_label: '720p',
    },
    tile: placeholderTile('camera-moves'),
  },
  {
    // VFX (09.3 SC5): style_grid pack — dramatic visual effect applied to a single uploaded
    // photo. Same freeform routing rationale as Camera Moves above.
    preset_id: 'vfx-pack',
    title: 'VFX',
    section: 'video_effects',
    sort_order: 7,
    status: 'live',
    badge: 'NEW',
    media_type: 'video',
    model: 'bytedance/seedance-2.0-mini',
    i2v_routing: 'try_seedance_fallback_grok',
    prompt_template:
      'Animate this photo with a dramatic {style} visual effect applied to the subject, ' +
      'keep the subject recognizable throughout, cinematic quality, no audio.',
    input_schema: {
      slots: [{ kind: 'image', label: 'Your photo', source: 'any' }],
      style_grid: [
        { id: 'on-fire', label: 'On Fire' },
        { id: 'disintegrate', label: 'Disintegrate' },
        { id: 'levitate', label: 'Levitate' },
        { id: 'gold', label: 'Gold' },
        { id: 'marble', label: 'Marble' },
      ],
    },
    cost: { type: 'per_second', credits_per_sec: 9, max_seconds: 5 },
    sheet: {
      description: 'Upload a photo — apply a dramatic visual effect.',
      aspect_label: 'Matches your photo',
      duration_label: '5s',
      resolution_label: '720p',
    },
    tile: placeholderTile('vfx-pack'),
  },
  {
    // Korean Baseball Fan Cam (09.6 D-02, FINAL 2026-07-12): SINGLE-SHOT — selfie straight into
    // HappyHorse 1.1 (no GPT-Image-2 compositor step; dropped for the generate-then-reupload
    // latency hit). The stadium-fancam illusion rides entirely on prompt strength (the reference
    // + STRONG prompt combo), so this is the existing 09.3 single-call 'video' path + postprocess
    // mux — NOT a chain (chain primitive's sole 9.6 consumer is You vs You).
    // 09.6 D-02 FALLBACK: if HappyHorse preserves the selfie's original background instead of
    // transplanting to the stadium (build-time test), add a Wan 2.7 Image compositor step (same
    // model UVU uses, Plan 05 — NOT GPT-Image-2, which was rejected for permissiveness) and
    // convert this row to a chain (see Plans 04/05).
    preset_id: 'kbo-fan-cam',
    title: 'Korean Baseball Fan Cam',
    subtitle: 'You, in the stands',
    section: 'video_effects',
    sort_order: 8,
    status: 'live',
    badge: 'NEW',
    media_type: 'video',
    model: 'alibaba/happyhorse-1.1',
    prompt_template:
      'Turn this selfie into a candid Korean baseball stadium fan-cam shot: telephoto lens ' +
      'compression, the person seated in the stadium crowd under bright stadium floodlights at ' +
      'night, cheering and reacting with excitement, other fans blurred around them in a candid ' +
      'crowd framing, vertical 9:16 broadcast composition, a lower-third scoreboard graphic overlay ' +
      'at the bottom of frame (generic team names and score, no real team or broadcaster logos), ' +
      'mild broadcast-camera softness and grain, preserve the person\'s exact face and identity.',
    input_schema: {
      slots: [{ kind: 'image', label: 'Your selfie', source: 'any' }],
    },
    // TODO(art): default stadium ambience/crowd-noise track — replace via `npm run
    // upload:preset-art` once delivered (D-09).
    postprocess: { op: 'mux', audio_r2_key: 'assets/presets/kbo-fan-cam/audio-v1.m4a' },
    // $0.14/sec @720p (HappyHorse pricing, matches D-01's UVU rate) — computeHappyHorseCost.
    cost: { type: 'per_second', credits_per_sec: 14, max_seconds: 5 },
    sheet: {
      description:
        'Upload a selfie — land courtside in a candid Korean baseball stadium fan-cam moment.',
      aspect_label: 'Vertical',
      duration_label: '5s',
      resolution_label: '720p',
    },
    tile: placeholderTile('kbo-fan-cam'),
  },
  {
    // Marlon Motion Transfer (09.6 D-03, FINAL 2026-07-12, "Method 1"): SINGLE-SHOT — user photo
    // + a bundled driver clip straight into Wan 2.2 animate-replace (ALREADY WIRED for
    // ai-influencer, reused verbatim here). No GPT-Image-2 step. `driver_video_asset` (server-only)
    // is injected as the character_replace_video; the user's single photo slot becomes
    // character_replace_image — see presetResolver's character_replace case below.
    preset_id: 'marlon-motion',
    title: 'Marlon Motion Transfer',
    subtitle: 'Step into the clip',
    section: 'video_effects',
    sort_order: 9,
    status: 'live',
    badge: 'HOT',
    media_type: 'character_replace',
    model: 'wan-video/wan-2.2-animate-replace',
    prompt_template: '', // character_replace path uses no text prompt
    input_schema: {
      slots: [{ kind: 'image', label: 'Your photo', source: 'any' }],
    },
    // TODO(art): real bundled driver clip — replace via `npm run upload:preset-art` once
    // delivered (D-09); presetResolver injects this URL as character_replace_video.
    driver_video_asset: 'assets/presets/marlon-motion/driver-v1.mp4',
    // TODO(art): default trend/driver audio track — replace via `npm run upload:preset-art`.
    postprocess: { op: 'mux', audio_r2_key: 'assets/presets/marlon-motion/audio-v1.m4a' },
    cost: { type: 'per_second', credits_per_sec: 5, max_seconds: 30 },
    sheet: {
      description:
        'Upload your photo — step into the clip, matching every move, pose, and beat exactly.',
      aspect_label: 'Matches the clip',
      duration_label: 'Up to 30s',
      resolution_label: '720p',
    },
    tile: placeholderTile('marlon-motion'),
  },
  {
    // You vs You (09.6 D-01, FINAL 2026-07-12): the phase's SOLE chain preset — proves the
    // chained-job primitive built in Plans 04-05. Two Wan 2.7 Image keyframes (opening arena
    // walk-in + young-you spotlight reveal) both land in HappyHorse's `images` reference array,
    // with a choreography prompt naming image-1 as the opening and image-2 as the ending reveal
    // (creative-liberty, not strict keyframe interpolation — D-01). Real billing is
    // computeChainCost() = 2 x IMAGE_MODEL_COSTS['wan-video/wan-2.7-image'] (Plan 05's
    // live-verified value) + computeHappyHorseCost(5, '720p') — `cost` below is a display hint
    // only. Generic server prompts, no real names/IP (D-09).
    preset_id: 'you-vs-you',
    title: 'You vs You',
    subtitle: 'Face your next opponent',
    section: 'video_effects',
    sort_order: 10,
    status: 'live',
    badge: 'HOT',
    media_type: 'chain',
    model: 'alibaba/happyhorse-1.1',
    prompt_template: '', // chain path uses no top-level prompt_template — def.chain carries both prompts
    input_schema: {
      slots: [
        { kind: 'image', label: 'Your photo', source: 'any' },
        { kind: 'image', label: 'Another photo of you', source: 'any', optional: true },
      ],
    },
    chain: {
      image_stage: {
        model: 'wan-video/wan-2.7-image',
        quality: 'high',
        prompts: [
          'A cinematic photorealistic keyframe of the exact same person from the reference photo(s), ' +
            'now walking into a vast dark cinematic arena alone, dramatic rim lighting, fog and haze in ' +
            'the air, cold blue-toned shadows, tunnel entrance silhouette behind them, tense atmosphere ' +
            'like the walkout before a championship match, vertical 9:16 framing, preserve the person\'s ' +
            'exact face and identity.',
          'A cinematic photorealistic keyframe of a noticeably younger version of the exact same person ' +
            'from the reference photo(s), standing center-frame under a single bright spotlight in the ' +
            'same dark arena, confident stance, warm golden spotlight beam cutting through haze, the rest ' +
            'of the arena in darkness, triumphant reveal moment, vertical 9:16 framing, preserve the ' +
            'person\'s exact facial identity, only de-age the apparent age.',
        ],
      },
      animate_stage: {
        model: 'alibaba/happyhorse-1.1',
        resolution: '720p',
        duration: 5,
        aspect_ratio: '9:16',
        prompt_template:
          'Animate a short cinematic sequence using image-1 as the opening shot (the person walking ' +
          'into the dark arena) and image-2 as the ending shot (their younger self revealed under the ' +
          'spotlight). Creative liberty on the camera move and transition between the two moments — this ' +
          'is not a strict frame interpolation, invent a compelling walk-in-to-reveal choreography that ' +
          'lands on image-2 as the final beat, dramatic lighting throughout, vertical 9:16.',
      },
    },
    // TODO(art): default "your next opponent: you" trend-audio track, aligned to the reveal
    // beat — replace via `npm run upload:preset-art` once delivered (D-01/D-09).
    postprocess: { op: 'mux', audio_r2_key: 'assets/presets/you-vs-you/audio-v1.m4a' },
    // Display hint only — real billing is computeChainCost() (see comment above), NOT this field.
    cost: { type: 'per_second', credits_per_sec: 14, max_seconds: 15 },
    sheet: {
      description:
        'Upload a photo (or two) — face your next opponent: an epic arena walk-in that reveals ' +
        'a younger you under the spotlight.',
      aspect_label: 'Vertical',
      duration_label: '5s',
      resolution_label: '720p',
    },
    tile: placeholderTile('you-vs-you'),
  },

  // ─── Photo Effects (output = still image — D-02 revised 2026-07-06, below Video Effects) ─
  {
    // Clothes Swap (09.1-11, 2026-07-07 — replaces the earlier avatar-based "AI Try-On" concept,
    // see 09.1-CONTEXT.md D-24-D-29 SUPERSEDED banner + parked/09.1-11-PLAN-avatar-tryon.md).
    // Higgsfield "Outfit Swap"-style: the user brings a fresh photo of themself every time (no
    // one-time avatar setup) plus 1 required + up to 2 optional outfit references. Reuses the
    // existing media_type:'image' -> GPT-Image-2 input_images pipeline unchanged.
    preset_id: 'clothes-swap',
    title: 'Clothes Swap',
    section: 'photo_effects',
    sort_order: 1,
    status: 'live',
    badge: 'NEW',
    media_type: 'image',
    model: 'openai/gpt-image-2-medium', // D-22: medium tier, 5 credits
    prompt_template:
      'The first image shows a person; the remaining image(s) show an outfit/clothing to dress ' +
      'them in. Composite the person wearing that outfit — preserve their face, identity, body ' +
      'shape, pose, and background exactly unchanged, only replace their clothing, and blend the ' +
      'garment fabric, lighting, and shadows realistically onto their body.',
    input_schema: {
      slots: [
        { kind: 'image', label: 'Your photo', source: 'any' },
        { kind: 'image', label: 'Outfit', source: 'any' },
        { kind: 'image', label: 'Add reference', source: 'any', optional: true },
        { kind: 'image', label: 'Add reference', source: 'any', optional: true },
      ],
    },
    cost: { type: 'flat', credits: 5 },
    sheet: {
      description:
        'Upload your photo and an outfit you like — see yourself wearing it.',
      // Verified against Replicate's openai/gpt-image-2 model page: aspect_ratio accepts
      // exactly 1:1, 3:2, 2:3 (no other values) — https://replicate.com/openai/gpt-image-2.
      aspect_ratios: ['3:2', '1:1', '2:3'],
      default_aspect_ratio: '1:1',
      resolution_label: 'High resolution',
    },
    // TODO(art): real poster/loop art not yet delivered for the renamed preset_id
    // ('try-on' -> 'clothes-swap') — needs its own backend/assets/preset-art/clothes-swap/
    // folder through the existing `npm run upload:preset-art` path (D-09). Placeholder tile is
    // the acceptable in-development stand-in until then.
    tile: placeholderTile('clothes-swap'),
  },
  {
    preset_id: 'hairstyle',
    title: 'Hairstyle',
    section: 'photo_effects',
    sort_order: 2,
    status: 'live',
    media_type: 'image',
    // D-22: presets always call GPT-Image-2 at its 'medium' tier (5 credits) — no
    // quality picker in PresetInputSheet. IMAGE_MODEL_COSTS['openai/gpt-image-2-medium'] = 5.
    model: 'openai/gpt-image-2-medium',
    prompt_template: "Change this person's hairstyle to {style}, keep the face and background unchanged.",
    // Used instead of prompt_template when the chosen style has a thumb_url (sent as a second
    // reference image) — see presetResolver.ts. gender_tag values below are a first-pass
    // proposal pending sign-off (2026-07-07 notes/hairstyle-preset-style-images-gender-filter.md).
    prompt_template_with_reference:
      'Give the person in the first image this exact hairstyle: {style} — matching the reference ' +
      'photo in the second image. Keep their face and background unchanged.',
    input_schema: {
      slots: [{ kind: 'image', label: 'Your photo', source: 'any' }],
      style_grid: [
        { id: 'bob', label: 'Bob', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/bob-v1.jpg' },
        { id: 'pixie-cut', label: 'Pixie Cut', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/pixie-cut-v1.jpg' },
        { id: 'crew-cut', label: 'Buzz', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/crew-cut-v1.jpg' },
        { id: 'slicked-back', label: 'Slicked Back', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/slicked-back-v1.jpg' },
        { id: 'french-braid', label: 'French Braid', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/french-braid-v2.jpg' },
        { id: 'box-braids', label: 'Box Braids', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/box-braids-v2.jpg' },
        // 2026-07-12: male hairstyle batch — reference photos for masculine-tagged styles.
        { id: 'balding', label: 'Balding', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/balding-v2.jpg' },
        { id: 'bald', label: 'Bald', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/bald-v1.jpg' },
        { id: 'blond-buzzcut', label: 'Blond Buzzcut', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/blond-buzzcut-v1.jpg' },
        { id: 'cornrows', label: 'Cornrows', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/cornrows-v1.jpg' },
        { id: 'dreads', label: 'Dreads', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/dreads-v1.jpg' },
        { id: 'frosted-tips', label: 'Frosted Tips', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/frosted-tips-v1.jpg' },
        { id: 'mohawk', label: 'Mohawk', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/mohawk-v1.jpg' },
        { id: '360-waves', label: 'Waves', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/waves-v1.jpg' },
        { id: 'bieber', label: 'Bieber', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/bieber-v1.jpg' },
        { id: 'choppy-fringe', label: 'Choppy Fringe', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/choppy-fringe-v1.jpg' },
        { id: 'combover', label: 'Combover', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/combover-v1.jpg' },
        { id: 'edgar-cut', label: 'Edgar Cut', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/edgar-cut-v1.jpg' },
        { id: 'fringe', label: 'Fringe', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/fringe-v1.jpg' },
        { id: 'long-hair', label: 'Long Hair', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/long-hair-v1.jpg' },
        { id: 'man-bun', label: 'Man Bun', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/man-bun-v1.jpg' },
        { id: 'middle-part', label: 'Middle Part', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/middle-part-v1.jpg' },
        { id: 'mullet', label: 'Mullet', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/mullet-v1.jpg' },
        { id: 'quiff', label: 'Quiff', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/quiff-v1.jpg' },
        { id: 'short-afro', label: 'Short Afro', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/short-afro-v1.jpg' },
        // 2026-07-14: distinct full/classic afro (round, high-volume) vs the tighter faded
        // "Short Afro" above — '-mens' suffix avoids colliding with the feminine 'afro' id below.
        { id: 'mens-afro', label: 'Afro', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/mens-afro-v2.jpg' },
        { id: 'short', label: 'Short', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/short-v2.jpg' },
        { id: 'swept-back', label: 'Swept Back', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/swept-back-v1.jpg' },
        { id: 'textured-fringe', label: 'Textured Fringe', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/textured-fringe-v1.jpg' },
        { id: 'wolf-cut', label: 'Wolf Cut', gender_tag: 'masculine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/wolf-cut-v1.jpg' },
        // 2026-07-13: women's hairstyle batch — reference photos for feminine-tagged styles (wired
        // identically to the male batch: thumb_url doubles as the 2nd reference image sent to
        // gpt-image-2, {style}=label). Color-only variants (blonde/silver/pink/highlights) are
        // uploaded but intentionally NOT listed here yet — pending color-swap-vs-hairstyle-swap
        // decision (they share one wavy-lob cut, so as hairstyle swaps they'd also change the cut).
        { id: 'afro', label: 'Afro', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/afro-v3.jpg' },
        { id: 'bantu-knots', label: 'Bantu Knots', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/bantu-knots-v1.jpg' },
        { id: 'braids', label: 'Braids', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/braids-v1.jpg' },
        { id: 'feed-in-braids', label: 'Feed-in Braids', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/feed-in-braids-v1.jpg' },
        { id: 'long-shag', label: 'Long Shag', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/long-shag-v1.jpg' },
        { id: 'long-wavy', label: 'Long Wavy', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/long-wavy-v1.jpg' },
        { id: 'messy-bun', label: 'Messy Bun', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/messy-bun-v3.jpg' },
        { id: 'pigtails', label: 'Pigtails', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/pigtails-v1.jpg' },
        { id: 'textured-lob', label: 'Textured Lob', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/textured-lob-v1.jpg' },
        { id: 'wash-and-go', label: 'Wash & Go', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/wash-and-go-v1.jpg' },
        { id: 'womens-wolf-cut', label: 'Wolf Cut', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/womens-wolf-cut-v1.jpg' },
        { id: 'womens-bald', label: 'Bald', gender_tag: 'feminine', thumb_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/womens-bald-v1.jpg' },
      ],
    },
    cost: { type: 'flat', credits: 5 },
    sheet: {
      description:
        'Try a new hairstyle on your own photo — pick a style below and see yourself with a ' +
        'fresh new look.',
      // gpt-image-2 supports 1:1, 3:2, 2:3, 16:9, 9:16, auto (Replicate playground, 2026-07-08).
      aspect_ratios: ['16:9', '1:1', '9:16'],
      default_aspect_ratio: '1:1',
      resolution_label: 'High resolution',
    },
    tile: {
      // v2 (2026-07-08): re-ingested at native 720x1280 (was downscaled to 360x640) — the grid
      // tile's head-focused crop zooms into this asset, and the old low-res version visibly
      // blurred under that zoom (user-reported).
      poster_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/poster-v2.jpg',
      loop_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/loop-v2.mp4',
      aspect: '3:4',
    },
  },
  {
    preset_id: 'anime-yourself',
    title: 'Anime Yourself',
    section: 'photo_effects',
    sort_order: 3,
    status: 'live',
    media_type: 'image',
    model: 'openai/gpt-image-2-medium', // D-22: medium tier, 5 credits
    // Server-only (D-11) — never reaches the client, so the "Studio Ghibli" reference here
    // carries no trademark/App-Review exposure (that risk was about the user-facing feature
    // NAME, which stays "Anime Yourself" — see presets-report.md item 12). GPT-Image-2 is the
    // permissive model for this ("it powered the 2025 Ghibli wave" per research), so it accepts
    // the style reference directly instead of the generic "vibrant Japanese anime" wording.
    prompt_template:
      'Transform this photo into a high-quality Studio Ghibli-style anime illustration of the ' +
      'same person, preserving their identity, pose, expression, and outfit — soft painterly ' +
      'backgrounds, warm natural lighting, hand-drawn watercolor texture.',
    input_schema: {
      slots: [{ kind: 'image', label: 'Your photo', source: 'any' }],
    },
    cost: { type: 'flat', credits: 5 },
    sheet: {
      description:
        'Turn your photo into a hand-drawn, Studio-quality anime illustration of yourself.',
      aspect_ratios: ['3:2', '1:1', '2:3'],
      default_aspect_ratio: '1:1',
      resolution_label: 'High resolution',
    },
    tile: placeholderTile('anime-yourself'),
  },
  {
    preset_id: 'polaroid',
    title: 'Polaroid Hug',
    section: 'photo_effects',
    sort_order: 4,
    status: 'live',
    media_type: 'image',
    model: 'openai/gpt-image-2-medium', // D-22: medium tier, 5 credits
    // The first two inputs teach GPT Image 2 the childhood/adulthood Polaroid Hug composition;
    // presetResolver appends the user's childhood + adulthood photos after them in slot order.
    fixed_reference_keys: [
      'preset-assets/polaroid/references/example-1.png',
      'preset-assets/polaroid/references/example-2.png',
    ],
    prompt_template:
      'The FIRST TWO images are visual examples only: they show the desired childhood/adulthood ' +
      'Polaroid Hug composition and aesthetic. Do not copy or depict the people from those example ' +
      'images. Create a new single photorealistic Polaroid photograph using the people in the LAST ' +
      'TWO images: image 3 is the person as a child and image 4 is the same person as an adult. ' +
      'Preserve both ages and facial identities faithfully. The adult must lovingly hold or hug ' +
      'their younger self. You have creative liberty with natural standing or seated poses and should ' +
      'vary the camera framing between chest-up and waist-up compositions so the results do not all ' +
      'use the same pose or crop. Vary their natural expressions too: they may smirk or smile with ' +
      'their teeth showing. Keep both faces clearly visible. Use subtle vintage instant-film ' +
      'grain and warm natural color. Make one cohesive photograph, not a collage. The surrounding ' +
      'non-photo Polaroid card/border must be clean pure white.',
    input_schema: {
      slots: [
        { kind: 'image', label: 'Childhood photo', source: 'any' },
        { kind: 'image', label: 'Adult photo', source: 'any' },
      ],
    },
    cost: { type: 'flat', credits: 5 },
    sheet: {
      description:
        'Upload a childhood photo and an adult photo — hold your younger self in a timeless Polaroid.',
      aspect_ratios: ['3:2', '1:1', '2:3'],
      default_aspect_ratio: '2:3',
      resolution_label: 'High resolution',
    },
    tile: {
      poster_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/polaroid/poster-v1.jpg',
      loop_url: 'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/polaroid/loop-v1.mp4',
      aspect: '3:4',
    },
  },
  {
    preset_id: 'enhancer-image',
    title: 'AI Enhance',
    subtitle: 'Photo',
    section: 'photo_effects',
    sort_order: 5,
    status: 'live',
    media_type: 'upscale',
    model: 'recraft-ai/recraft-crisp-upscale',
    prompt_template: '', // upscale path takes no text prompt
    input_schema: {
      slots: [{ kind: 'image', label: 'Image to enhance', source: 'any' }],
    },
    cost: { type: 'flat', credits: 1 },
    sheet: {
      description: 'Sharpen and upscale any photo for a cleaner, higher-resolution result.',
      aspect_label: 'Matches your photo',
    },
    tile: placeholderTile('enhancer-image'),
  },
  {
    preset_id: 'faceswap',
    title: 'Faceswap',
    section: 'photo_effects',
    sort_order: 6,
    status: 'live',
    badge: 'NEW',
    media_type: 'faceswap',
    // 09.2-12: re-pointed to inline OpenAI gpt-image-2 — easel/advanced-face-swap was REMOVED
    // from Replicate (404 confirmed 2026-07-09). The swap prompt is server-side (FACESWAP_PROMPT
    // in openaiImageService.ts), not this registry's prompt_template.
    model: 'openai/gpt-image-2-medium',
    prompt_template: '', // faceswap takes no text prompt
    input_schema: {
      slots: [
        { kind: 'image', label: 'Your face', source: 'any' }, // swap_image (user's face)
        { kind: 'image', label: 'Target photo', source: 'any' }, // target_image
      ],
    },
    cost: { type: 'flat', credits: 5 }, // gpt-image-2-medium tier
    sheet: {
      description:
        'Swap your face onto any photo — upload your face and the photo to place it into.',
      aspect_label: 'Matches your photo',
      resolution_label: 'High resolution',
    },
    tile: placeholderTile('faceswap'),
  },
  {
    // Magic Editor (SC4, 09.2-08): OpenAI-DIRECT inline mask edit — the mask itself is NOT a
    // registry slot (the client paints it and uploads it separately as mask_upload_id); only the
    // source photo is a declared slot here. The only image preset with a user free-text field —
    // presetResolver passes the client's sanitized text straight through as the prompt
    // (prompt_template '{prompt}' is a passthrough marker, not server-templated like the others).
    preset_id: 'magic-editor',
    title: 'Magic Editor',
    subtitle: 'Paint to edit',
    section: 'photo_effects',
    sort_order: 7,
    status: 'live',
    badge: 'NEW',
    media_type: 'image',
    model: 'openai/gpt-image-2-medium', // D-22: medium tier, 5 credits
    prompt_template: '{prompt}',
    input_schema: {
      slots: [{ kind: 'image', label: 'Photo to edit', source: 'any' }],
      text: { label: 'What to change (optional)', required: false },
    },
    cost: { type: 'flat', credits: 5 },
    sheet: {
      description:
        'Paint over any part of your photo and describe what to change — or leave it blank to remove it.',
      aspect_label: 'Matches your photo',
      resolution_label: 'High resolution',
    },
    tile: placeholderTile('magic-editor'),
  },
  {
    // Action Figure (09.3 SC5): first registry-drop image template — individual photo_effects
    // card (not a pack), like Anime Yourself / Polaroid Hug.
    preset_id: 'action-figure',
    title: 'Action Figure',
    section: 'photo_effects',
    sort_order: 8,
    status: 'live',
    badge: 'NEW',
    media_type: 'image',
    model: 'openai/gpt-image-2-medium', // D-22: medium tier, 5 credits
    prompt_template:
      'Transform this person into a collectible blister-pack action figure — full-body plastic ' +
      'action-figure sculpt of the same person, posed on a display base, packaged in a retail ' +
      'blister-pack toy box with cardboard header art, preserving their likeness, outfit, and ' +
      'accessories as figure-scale details.',
    input_schema: {
      slots: [{ kind: 'image', label: 'Your photo', source: 'any' }],
    },
    cost: { type: 'flat', credits: 5 },
    sheet: {
      description: 'Turn yourself into a blister-pack action figure.',
      aspect_ratios: ['3:2', '1:1', '2:3'],
      default_aspect_ratio: '1:1',
      resolution_label: 'High resolution',
    },
    tile: placeholderTile('action-figure'),
  },
  {
    // 90s Yearbook (09.3 SC5): first registry-drop image template.
    preset_id: 'yearbook-90s',
    title: '90s Yearbook',
    section: 'photo_effects',
    sort_order: 9,
    status: 'live',
    media_type: 'image',
    model: 'openai/gpt-image-2-medium', // D-22: medium tier, 5 credits
    prompt_template:
      'Transform this photo into a classic 1990s school yearbook portrait of the same person — ' +
      'soft studio laser-background, period-accurate 90s hairstyle and clothing styling, warm ' +
      'film color grading, preserving their identity and facial features exactly.',
    input_schema: {
      slots: [{ kind: 'image', label: 'Your photo', source: 'any' }],
    },
    cost: { type: 'flat', credits: 5 },
    sheet: {
      description: 'Get a classic 90s school yearbook portrait.',
      aspect_ratios: ['3:2', '1:1', '2:3'],
      default_aspect_ratio: '1:1',
      resolution_label: 'High resolution',
    },
    tile: placeholderTile('yearbook-90s'),
  },
  {
    // Pro Headshot (09.3 SC5): first registry-drop image template.
    preset_id: 'pro-headshot',
    title: 'Pro Headshot',
    section: 'photo_effects',
    sort_order: 10,
    status: 'live',
    media_type: 'image',
    model: 'openai/gpt-image-2-medium', // D-22: medium tier, 5 credits
    prompt_template:
      'Transform this selfie into a clean, professional corporate headshot of the same person — ' +
      'neutral studio background, professional business attire, soft even studio lighting, sharp ' +
      'focus, preserving their identity and facial features exactly.',
    input_schema: {
      slots: [{ kind: 'image', label: 'Your photo', source: 'any' }],
    },
    cost: { type: 'flat', credits: 5 },
    sheet: {
      description: 'A clean, professional headshot from any selfie.',
      aspect_ratios: ['3:2', '1:1', '2:3'],
      default_aspect_ratio: '1:1',
      resolution_label: 'High resolution',
    },
    tile: placeholderTile('pro-headshot'),
  },
  {
    // Restore Old Photo (09.3 SC5): first registry-drop image template. Distinct from
    // Animate Old Photo (video_effects) — this one keeps the still photo and only
    // colorizes/deblurs it.
    preset_id: 'restore-old-photo',
    title: 'Restore Old Photo',
    section: 'photo_effects',
    sort_order: 11,
    status: 'live',
    media_type: 'image',
    model: 'openai/gpt-image-2-medium', // D-22: medium tier, 5 credits
    prompt_template:
      'Restore this old, damaged photograph — repair scratches, creases, and tears, deblur and ' +
      'sharpen the image, naturally colorize it if it is black-and-white or faded, while ' +
      'preserving the exact identity, pose, and composition of the people and scene.',
    input_schema: {
      slots: [{ kind: 'image', label: 'Old photo', source: 'any' }],
    },
    cost: { type: 'flat', credits: 5 },
    sheet: {
      description:
        'Colorize and deblur an old photo — keep the memory, lose the damage.',
      aspect_ratios: ['3:2', '1:1', '2:3'],
      default_aspect_ratio: '1:1',
      resolution_label: 'High resolution',
    },
    tile: placeholderTile('restore-old-photo'),
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
    // Gorilla Vlogs (09.3 SC3/D-05, flipped soon → live): the character-system proof. A bundled
    // fictional AI character (no real face, no IP) — Seedance 2.0 reference-to-video with
    // audio-on accepts fictional/AI characters directly (D-02: fictional presets go straight to
    // Seedance, no Grok fallback needed). The user's raw script is expanded via
    // openaiScriptService.expandScript() into dialogue + selfie-cam vlog framing (D-05) before
    // dispatch — fail-open to a templated `{script}` substitution if the LLM call errors.
    preset_id: 'gorilla-vlogs',
    title: 'Gorilla Vlogs',
    section: 'shows_vlogs',
    sort_order: 1,
    status: 'live',
    badge: 'NEW',
    media_type: 'video',
    model: 'bytedance/seedance-2.0-mini',
    i2v_routing: 'seedance', // known-fictional character — best quality, no Grok fallback needed
    // TODO(art): placeholder character still — replace with the real bundled gorilla character
    // asset via `npm run upload:preset-art` once delivered (D-09); presetResolver injects this
    // URL into reference_images ahead of any user slots (there are none for this preset).
    character_asset: 'https://assets.fantasia.example/presets/gorilla-vlogs/character-v1.jpg',
    script_expansion: true,
    dialogue_prompt_template:
      'Selfie-cam vlog style, handheld phone camera framing: a gorilla vlogger holds up the ' +
      'phone to film themself talking directly to the camera, natural gestures, casual vlog ' +
      'energy, speaking the following as spoken dialogue: {script}',
    // Same-family fallback if dialogue_prompt_template is ever absent (defense-in-depth — mirrors
    // every other server-only template field's fallback shape in this registry).
    prompt_template:
      'Selfie-cam vlog style, handheld phone camera framing: a gorilla vlogger holds up the ' +
      'phone to film themself talking directly to the camera, natural gestures, casual vlog ' +
      'energy, speaking the following as spoken dialogue: {script}',
    input_schema: {
      slots: [],
      text: { label: 'Your script', required: true },
    },
    // Matches animate-old-photo's Seedance-mini 720p per-second rate (MODEL_RATES nonVideoIn
    // 720p = $0.09/s = 9 credits/s).
    cost: { type: 'per_second', credits_per_sec: 9, max_seconds: 5 },
    sheet: {
      description: 'Type a short script — the gorilla vlogs it, selfie-cam style, with speech.',
      aspect_label: 'Vertical',
      duration_label: '5s',
      resolution_label: '720p',
      preparing_label: 'Writing your script…',
    },
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
 * Client-facing projection of SERVER_PRESETS — every SERVER-ONLY field (D-11, 09.3 D-02/D-03/D-05)
 * deleted before this array is ever touched by a response serializer, including a deep strip of
 * `input_schema.style_grid[].driving_video_url` (09.3 D-04, bundled motion-pack driving clips).
 * GET /api/presets serves this, never SERVER_PRESETS.
 */
export const CLIENT_PRESETS = SERVER_PRESETS.map((def) => {
  const {
    prompt_template,
    prompt_template_with_reference,
    fixed_reference_keys,
    character_asset,
    script_expansion,
    dialogue_prompt_template,
    postprocess,
    i2v_routing,
    chain,
    driver_video_asset,
    ...rest
  } = def;

  if (rest.input_schema?.style_grid?.length) {
    rest.input_schema = {
      ...rest.input_schema,
      style_grid: rest.input_schema.style_grid.map(({ driving_video_url, ...styleRest }) => styleRest),
    };
  }

  return rest;
});
