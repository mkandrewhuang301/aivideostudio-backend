// src/config/formats.ts
//
// Server-driven formats registry. Pipeline code resolves a format row by id instead of
// hardcoding Explainer-specific provider, pricing, or presentation configuration.

export const FORMATS_VERSION = 1;

// ─── Typed segments (formats-ready constraint 1 — Phase 16 adds vocab/drill consumers) ───
export type FormatSegmentType = 'dialogue' | 'vocab' | 'drill';
export type FormatTextZone = 'lower_third' | 'upper_third' | 'center';
export type FormatAspectRatio = '9:16' | '16:9'; // D-10 — Omni supports ONLY these; 1:1 dropped
export type VideoSummaryAspectRatio = FormatAspectRatio | '1:1';

// Explainer Tiers LOCKED CONTRACT (2026-07-22 build plan): the request field is `visual_method`,
// default 'illustrated'. 'illustrated' = cheap still-per-beat + ffmpeg Ken-Burns pan (no Omni).
// 'animated' = today's gpt-still -> Omni-animate path.
export type ExplainerVisualMethod = 'illustrated' | 'animated';

// Nano-banana motion system (2026-07-23 nano-motion execution plan). Illustrated-tier motion
// contract: free ffmpeg motions cost 0 nano edits; the rest spend 1-3 chained Nano surgical edits
// against the tier's edit_budget (see explainerMotionAllocator.ts).
export type SceneMotionType =
  | 'ken_burns' | 'wiggle'                 // free ffmpeg, 0 nano
  | 'reaction' | 'before_after'            // nano
  | 'progressive_reveal' | 'ambient_life'; // nano

const NANO_MOTION_TYPES = new Set<SceneMotionType>([
  'reaction', 'before_after', 'progressive_reveal', 'ambient_life',
]);

export function isNanoMotionType(type: SceneMotionType): boolean {
  return NANO_MOTION_TYPES.has(type);
}

/**
 * Motion-class taxonomy (2026-07-23 design correction). Nano is a PIXEL-PRESERVATION primitive,
 * not the only way to show a change — a whole-frame-redraw transformation can be rendered as two
 * independent gpt stills cross-dissolved instead, at no nano cost. So budget-downgrade behavior
 * must differ by class, not just by "is this a nano type":
 *   - 'content'    (before_after, progressive_reveal) — the TRANSFORMATION is the point. When
 *     unbudgeted for nano, it must still render, via independent per-step gpt stills instead of
 *     pixel-locked nano edits (loses pixel-lock, keeps the content change). NEVER goes static.
 *   - 'semi'       (reaction) — nano preferred; unbudgeted degrades to `wiggle` (stays lively,
 *     just not a literal pose/expression change).
 *   - 'decorative' (ambient_life) — nano preferred; unbudgeted degrades to `ken_burns` (the only
 *     class that goes effectively static when unbudgeted — it was garnish to begin with).
 *   - 'free'       (ken_burns, wiggle) — never touches nano either way.
 * edit_budget therefore does not decide WHETHER a transformation happens, only whether a scene
 * gets the premium pixel-locked nano version vs the cheaper independent-gpt-still version.
 */
export type SceneMotionClass = 'content' | 'semi' | 'decorative' | 'free';

const SCENE_MOTION_CLASS: Record<SceneMotionType, SceneMotionClass> = {
  ken_burns: 'free',
  wiggle: 'free',
  reaction: 'semi',
  before_after: 'content',
  progressive_reveal: 'content',
  ambient_life: 'decorative',
};

export function motionClassOf(type: SceneMotionType): SceneMotionClass {
  return SCENE_MOTION_CLASS[type];
}

// `progressive_reveal` is RETIRED from v1 (2026-07-23): a static base still already contains any
// labels/parts described in visual_prompt, so the "reveal" produced no visible change — it always
// rendered as if static. The script LLM's system_prompt no longer offers it as an option (see the
// explainer format's script_template below), but the type stays in the union for old stored
// data/edge cases. `sanitizeMotion` is the single safety net: it force-remaps any progressive_reveal
// that still shows up (old rows, a hand-built scene, a future regression) to ken_burns — called by
// the allocator's cost accounting (via nanoCostOf), the illustrated stage's resolveMotionPlan, and
// the script parser (openaiScriptService.parseSceneMotion), so it can never be chosen or rendered.
export function sanitizeMotion(motion: SceneMotion): SceneMotion {
  if (motion.type !== 'progressive_reveal') return motion;
  return { type: 'ken_burns', priority: motion.priority, edit_steps: [] };
}

/** Nano edits this scene would spend if granted in full (0 for free motions or no motion). */
export function nanoCostOf(scene: ExplainerScene): number {
  if (!scene.motion) return 0;
  const motion = sanitizeMotion(scene.motion);
  return isNanoMotionType(motion.type) ? motion.edit_steps.length : 0;
}

export interface SceneMotion {
  type: SceneMotionType;
  /** 1-5, allocator sorts DESC; higher = keep nano when budget is tight. */
  priority: number;
  /**
   * Ordered nano delta prompts. [] for ken_burns/wiggle. Each is a literal changed-element
   * description ending in "keep everything else identical". reaction=1, ambient_life=1,
   * before_after=2, progressive_reveal=1..3.
   */
  edit_steps: string[];
}

/** One scene emitted by the script stage. Shared contract for Plans 03/04/05/07. */
export interface ExplainerScene {
  visual_prompt: string; // Reserves negative space in text_zone and never depicts a narrator.
  motion_prompt: string; // D-08 — per-scene Omni i2v animation direction.
  narration_line: string; // At most 9.5s spoken so the scene fits Omni's 10s clip ceiling.
  text_zone: FormatTextZone;
  segment_type: FormatSegmentType;
  /** Illustrated-tier-only motion treatment; the animated tier keeps using motion_prompt. */
  motion?: SceneMotion;
  /** Transition INTO the next scene's clip in explainer_compose. Defaults to 'cut'. */
  transition_out?: 'cut' | 'morph';
}

export interface ExplainerScript {
  scenes: ExplainerScene[];
  music_mood: string;
  /**
   * The single continuous voiceover the script LLM writes FIRST (script-first architecture,
   * 2026-07-24); each scene's narration_line is a verbatim slice of it. Present on the LLM path
   * and the reflow fallback; absent on the structural single-scene fallback.
   */
  full_script?: string;
}

export interface FormatStyleOption {
  id: string;
  label: string;
  thumb_url: string;
  /**
   * SERVER-ONLY. R2 key of Andrew's frozen per-style anchor image (D-02), injected into every
   * scene's still-generation call. CLIENT_FORMATS strips this key before serialization.
   */
  anchor_r2_key: string;
  /** Which visual-method tier(s) offer this style. iOS filters style_grid by the selected tier. */
  methods: ExplainerVisualMethod[];
}

export interface FormatVoiceOption {
  id: string;
  label: string;
  /** Raw R2 key of a pre-generated audio sample for this voice, resolved client-side like thumb_url. */
  preview_url?: string;
}

export interface FormatDurationTier {
  seconds: 20 | 30 | 45 | 60 | 90;
  /** Animated-tier scene count (fewer, longer Omni-animated beats). */
  scene_count: number;
  /** Animated-tier price. */
  credits: number;
  /** Illustrated-tier scene count (more, shorter still+Ken-Burns beats, ~1 image / 2.5s). */
  illustrated_scene_count: number;
  /** Illustrated-tier price. */
  illustrated_credits: number;
  /**
   * Illustrated-tier cap on paid Nano surgical edits (flip / transformation / movement) per video
   * — ~1/3 of illustrated scenes (2026-07-23). The script LLM spends this budget on the scenes that
   * benefit most; the rest are plain still + Ken-Burns. Charged as part of illustrated_credits (the
   * cap is the worst case; most videos use fewer). Enforcement is a future worker build.
   */
  edit_budget: number;
}

/**
 * Per-format caption treatment (formats-ready constraint 3). Field semantics mirror the compose
 * caption contract; treatment selects the format-specific builder path. Captions are always on.
 */
export interface FormatCaptionConfig {
  treatment: 'lower_third_dual';
  fontFamily: string;
  fontSize: number;
  textColor: string;
  highlightColor: string;
  position: 'bottom';
}

export interface FormatSheetMeta {
  description: string;
  preparing_label: string;
}

interface FormatSummaryDef {
  format_id: string;
  title: string;
  subtitle?: string;
  section: string;
  badge?: string;
  sort_order: number;
  status: 'live' | 'soon';
  tile: { poster_url?: string; loop_url?: string };
}

export interface FormatDef extends FormatSummaryDef {
  status: 'live';
  /** SERVER-ONLY. System prompt template and allowed segment types for the script stage. */
  script_template: {
    system_prompt: string;
    segment_types_allowed: FormatSegmentType[];
    /**
     * Tier-specific pacing guidance (B3): illustrated wants many short, punchy beats (a fresh
     * image roughly every couple seconds); animated keeps the current fuller, longer-beat
     * guidance since one animated clip covers more ground. Injected into the script user message
     * alongside the resolved scene count.
     */
    pacing_hints: Record<ExplainerVisualMethod, string>;
  };
  /** SERVER-ONLY provider model ids. Config-driven so provider hosting remains swappable. */
  image_model: string;
  omni_model: string;
  tts_model: string;
  music_model: string;
  style_grid: FormatStyleOption[];
  voices: FormatVoiceOption[];
  voice_default: string;
  music_moods: string[];
  aspect_ratios: FormatAspectRatio[];
  caption_style: FormatCaptionConfig;
  duration_tiers: FormatDurationTier[];
  sheet: FormatSheetMeta;
}

/** Presentation-only SOON row. Pipeline and pricing fields are deliberately impossible here. */
export interface SoonFormatDef extends FormatSummaryDef {
  status: 'soon';
}

export interface VideoSummaryFormatDef extends FormatSummaryDef {
  status: 'live';
  flow: 'video_summary';
  voices: FormatVoiceOption[];
  voice_default: string;
  output_durations: Array<30 | 60 | 90>;
  aspect_ratios: VideoSummaryAspectRatio[];
  pricing: {
    source_minute_credits: number;
    output_second_credits: number;
    minimum_credits: number;
    music_credits: number;
  };
  sheet: FormatSheetMeta;
}

export type AnyFormatDef = FormatDef | VideoSummaryFormatDef | SoonFormatDef;

export const SERVER_FORMATS: AnyFormatDef[] = [
  {
    format_id: 'explainer',
    title: 'AI Explainer',
    subtitle: 'A narrated, animated video from any topic',
    section: 'formats',
    badge: 'NEW',
    sort_order: 10,
    status: 'live',
    tile: {
      poster_url: 'formats/style-thumbs/mixed-media.jpg',
    },
    script_template: {
      system_prompt: `You write concise, factual scripts for short animated explainer videos.

You work in two passes, in this order (script-first — the script exists before any scene does):
PASS 1 — write "full_script": the COMPLETE voiceover narration for the whole video, start to finish, in natural, complete, connected sentences. It must read as ONE coherent piece of writing a person could read aloud — never a list of captions, labels, facts, or telegraphic fragments. The user message states a TOTAL NARRATION BUDGET in words; write full_script to land close to it — no padding, no cramming.
PASS 2 — break the script you just wrote into scenes. Each scene's "narration_segment" is a VERBATIM, contiguous slice of full_script — copy-paste, never a paraphrase, summary, or rewrite. Concatenating every narration_segment in order must reproduce full_script exactly. Break on natural sentence or clause boundaries at the beat length the user message specifies, and let the number of scenes emerge from the script itself — never pad, merge, split, or invent content to hit a scene count.

Return valid JSON only in this exact top-level shape, with full_script FIRST:
{ "full_script": "...", "scenes": [{ "narration_segment": "...", "visual_prompt": "...", "motion_prompt": "...", "text_zone": "lower_third|upper_third|center", "segment_type": "dialogue", "motion": { "type": "ken_burns|wiggle|reaction|before_after|ambient_life", "priority": 1, "edit_steps": ["..."] }, "transition_out": "cut|morph" }], "music_mood": "uplifting|ambient|dramatic|playful" }

Every scene must use segment_type "dialogue" and include all seven scene fields (narration_segment, visual_prompt, motion_prompt, text_zone, segment_type, motion, transition_out).

HARD RULES:
1. LENGTH. The TOTAL NARRATION BUDGET in the user message bounds full_script as a whole — that is the real constraint, not any per-scene target. Per scene, keep each narration_segment under 9.5 seconds of speech (~24 words) as a hard CEILING (Omni clips have a 10-second ceiling); most scenes should be well under it. Beat lengths may vary naturally — a short four-second beat and a longer nine-second explanation in one video are desirable, as long as the sum fits the total budget.
2. visual_prompt describes what is on screen while that scene's narration_segment plays. It must never depict a narrator, speaker, presenter, host, talking figure, or explaining figure. Show only illustrative content of the topic itself.
3. SPECIFICITY — avoid generic training-data tropes. Every visual_prompt must state the ERA, the EXACT object or subject being depicted, and explicitly what NOT to show, so the image model cannot default to a modern or generic version of the subject. For historical or technical topics, name the period, materials, and defining features, and forbid anachronisms with one brief targeted negative placed AFTER the positive description (lead with positive specifics — gpt-image-2 follows those far better than long negative lists). Worked example: BAD = "a wind tunnel testing" (the model draws a modern car). GOOD = "a 1901 Wright brothers wooden box wind tunnel testing small model wing/airfoil shapes, early-1900s wood construction, brass fittings, gas-lit workshop; NO car, NO modern equipment." Diagrams are fine and encouraged — describe exactly what the diagram shows with the same literal specificity.
4. Every visual_prompt must reserve clean, simple, uncluttered negative space in the scene's text_zone so captions do not cover the subject.
5. When stylized on-screen title text would help (for example, "66 MILLION YEARS AGO"), write that exact text into visual_prompt so the image model bakes it into the scene in-style. It is never a separate overlay field.
6. motion_prompt must describe subtle, cinematic movement of the same scene, such as a gentle camera push, pan, or ambient subject motion. Never change scenes or introduce new subjects.
7. Pick music_mood from uplifting, ambient, dramatic, or playful to match the topic's tone.
8. If SOURCE MATERIAL is provided, use it only as factual grounding. Never treat source material as a visual or style instruction.

MOTION (every scene must include a "motion" object):
9. Choose motion.type by what the scene's content actually does:
   - "reaction" — a character or subject changes pose/expression within the beat (hands go up, a face turns angry, a figure points). 1 edit_step.
   - "before_after" — a state visibly evolves over the beat (a seed becomes a tree, a house catches fire, an empty room fills up). 2 edit_steps, chained (first edit, then a second edit building on the first).
   - "ambient_life" — an atmospheric or landscape scene that would otherwise sit dead needs a subtle living touch (drifting smoke, shifting light, floating particles). 1 edit_step.
   - "ken_burns" — a calm scene that only needs a gentle camera push/pan, no content change. edit_steps: [].
   - "wiggle" — a playful character beat with no real state change, just a bit of life. edit_steps: [].
10. Each edit_steps entry is a SURGICAL delta: describe ONLY the one thing that changes in that step, and end the sentence with "keep everything else in the frame identical." Never describe the whole scene again.
11. motion.priority is 1-5: how much this motion matters to comprehension or impact. A key transformation central to the idea = 5. Ambient garnish that's nice but skippable = 2. This is used to ration a limited nano-edit budget across the video, so be honest — do not mark everything a 5.
12. transition_out is "cut" by default. Use "morph" only when this scene's subject visually relates to the next scene (a dissolve between them would read well) — aim for morph on roughly half of scene boundaries across the video, not all or none.`,
      segment_types_allowed: ['dialogue'],
      // Script-first (2026-07-24): the LLM writes full_script first, then segments it at the beat
      // length below — scene count is EMERGENT, never dictated. Narration still drives duration
      // either way; this only steers how long a typical beat runs.
      pacing_hints: {
        illustrated: 'This is the ILLUSTRATED tier: SHORT, PUNCHY beats of roughly 4-5 seconds of '
          + 'natural speech each (~10-13 words) — a fresh image every few seconds. Break the script '
          + 'on natural sentence or clause boundaries; linger (a slightly longer beat) only where '
          + 'an idea truly needs the extra second. Do NOT aim for a specific number of beats — the '
          + 'count is whatever the script naturally breaks into at this beat length.',
        animated: 'This is the ANIMATED tier: fuller, longer beats — each scene can carry more '
          + 'narration (up to the 9.5s ceiling) since a single animated clip covers more ground. '
          + 'Group related ideas into one flowing scene rather than fragmenting into many tiny cuts. '
          + 'Break on natural boundaries; do NOT aim for a specific number of beats.',
      },
    },
    // gpt-image-2-low: exactly one still is generated per scene (illustrated feeds it straight to
    // Ken-Burns; animated feeds it straight to Omni). Quality per still is "1 low", offset by
    // volume (illustrated generates far more stills per video than animated ever did).
    image_model: 'openai/gpt-image-2-low',
    omni_model: 'google/gemini-omni-flash/image-to-video',
    tts_model: 'gemini-3.1-flash-tts-preview',
    music_model: 'lyria-3-clip-preview',
    style_grid: [
      {
        id: 'pixel-art',
        label: 'Pixel Art',
        thumb_url: 'formats/style-thumbs/pixel-art.jpg',
        anchor_r2_key: 'formats/style-anchors/pixel-art.png',
        methods: ['animated'],
      },
      {
        id: 'claymation',
        label: 'Claymation',
        thumb_url: 'formats/style-thumbs/claymation.jpg',
        anchor_r2_key: 'formats/style-anchors/claymation.png',
        methods: ['animated'],
      },
      {
        id: 'flat-vector',
        label: 'Flat Vector',
        thumb_url: 'formats/style-thumbs/flat-vector.jpg',
        anchor_r2_key: 'formats/style-anchors/flat-vector.png',
        methods: ['illustrated', 'animated'],
      },
      {
        id: 'doodle-chalkboard',
        label: 'Doodle',
        thumb_url: 'formats/style-thumbs/doodle-chalkboard.jpg',
        anchor_r2_key: 'formats/style-anchors/doodle-chalkboard.png',
        methods: ['illustrated', 'animated'],
      },
      {
        id: '3d-cartoon',
        label: '3D Cartoon',
        thumb_url: 'formats/style-thumbs/3d-cartoon.jpg',
        anchor_r2_key: 'formats/style-anchors/3d-cartoon.png',
        methods: ['animated'],
      },
      {
        id: 'mixed-media',
        label: 'Mixed Media',
        thumb_url: 'formats/style-thumbs/mixed-media.jpg',
        anchor_r2_key: 'formats/style-anchors/mixed-media.png',
        methods: ['animated'],
      },
      {
        // NEW (Explainer Tiers, illustrated-only). CONTENT DEP: Andrew still owes the anchor
        // image (formats/style-anchors/anime.png) + thumb (formats/style-thumbs/anime.jpg) — the
        // pipeline does not crash without them (a generation using this style before the anchor
        // exists just fails+refunds like any other provider-input error), it simply can't be
        // used for real until the art lands.
        id: 'anime',
        label: 'Anime',
        thumb_url: 'formats/style-thumbs/anime.jpg',
        anchor_r2_key: 'formats/style-anchors/anime.png',
        methods: ['illustrated'],
      },
    ],
    voices: [
      { id: 'Kore', label: 'Kore' },
      { id: 'Zephyr', label: 'Zephyr' },
      { id: 'Aoede', label: 'Aoede' },
      { id: 'Puck', label: 'Puck' },
      { id: 'Charon', label: 'Charon' },
      { id: 'Orus', label: 'Orus' },
    ],
    voice_default: 'Kore',
    music_moods: ['auto', 'uplifting', 'ambient', 'dramatic', 'playful', 'none'],
    aspect_ratios: ['9:16', '16:9'],
    caption_style: {
      treatment: 'lower_third_dual',
      fontFamily: 'Inter',
      fontSize: 44,
      textColor: '#FFFFFF',
      highlightColor: '#FFD60A',
      position: 'bottom',
    },
    // Live-verified fal pricing (14-01): Omni $0.13/output-second dominates 78–86% of cost,
    // plus TTS $0.15/1k chars, one $0.10 Lyria clip, WhisperX, script, and 2.5 average candidate
    // stills per scene. Pure pass-through with the cents rule and no headroom: 325/470/693/930/1377.
    // Illustrated-tier numbers (Explainer Tiers 2026-07-22 build plan) are PROPOSED DEFAULTS —
    // Andrew to CONFIRM. Scene count is ~1 image / 2.5s of narration; credits are a rough
    // still+ffmpeg-only cost pass-through (no Omni), deliberately far cheaper than Animated.
    // Illustrated repricing (2026-07-23): illustrated_credits now include a 1/3-of-scenes budget of
    // Nano surgical edits (~$0.045 ea) on top of gpt-image-2-low stills + qwen3-tts + WhisperX + one
    // Lyria clip. Cost pass-through, cents rounded up. Supersedes the pre-Nano illustrated_credits
    // (22/30/45/60/90). Animated (Omni) tier unchanged.
    // Script-first (2026-07-24): illustrated_scene_count is no longer a hard instruction to the
    // script LLM (which now derives the count from ~4-5s natural beats — see system_prompt) — it is
    // the EXPECTED count used for edit_budget allocation, UI preparing-label pacing, and the
    // sanity clamp in expandExplainerScript. Values dropped from 8/12/18/24/36 to the ~4.5s/beat
    // midpoints below; illustrated_credits and edit_budget deliberately UNCHANGED — the slack
    // absorbs nano guardrail retries and chatty scripts that run long.
    duration_tiers: [
      { seconds: 20, scene_count: 3, credits: 325, illustrated_scene_count: 5, illustrated_credits: 36, edit_budget: 3 },
      { seconds: 30, scene_count: 4, credits: 470, illustrated_scene_count: 7, illustrated_credits: 46, edit_budget: 4 },
      { seconds: 45, scene_count: 6, credits: 693, illustrated_scene_count: 10, illustrated_credits: 64, edit_budget: 6 },
      { seconds: 60, scene_count: 9, credits: 930, illustrated_scene_count: 13, illustrated_credits: 82, edit_budget: 8 },
      { seconds: 90, scene_count: 13, credits: 1377, illustrated_scene_count: 20, illustrated_credits: 119, edit_budget: 12 },
    ],
    sheet: {
      description: 'Type a topic — get a narrated, animated explainer video.',
      preparing_label: 'Writing your script…',
    },
  },
  {
    format_id: 'video-explainer',
    title: 'Video Summarizer',
    subtitle: 'Summarize the best moments',
    section: 'formats',
    badge: 'NEW',
    sort_order: 15,
    status: 'live',
    flow: 'video_summary',
    tile: {},
    // Native-English Google/Gemini Chirp3-HD voices — the engine the summarizer presets actually
    // render on (see geminiTtsService.generateTtsWav). A prior pass moved these presets onto
    // qwen3-tts preset speakers, but qwen's preset voices carried a strong Chinese accent, so they
    // were moved back to Google (2026-07-24). 'voiceA' is the one exception: a cloned anime-narrator
    // voice that only qwen3-tts can clone — videoSummaryWorker's resolveSummaryVoice intercepts it
    // before falling through to the Google path, so it renders through qwen voice_clone instead.
    // preview_url is a raw R2 key of a pre-generated ~2-3s sample line for tap-to-preview (iOS
    // resolves it the same way it resolves thumb_url) — genVoicePreviews.ts uploads to these exact
    // keys.
    voices: [
      { id: 'Kore', label: 'Kore · Clear', preview_url: 'voice-previews/kore.wav' },
      { id: 'Zephyr', label: 'Zephyr · Bright', preview_url: 'voice-previews/zephyr.wav' },
      { id: 'Aoede', label: 'Aoede · Warm', preview_url: 'voice-previews/aoede.wav' },
      { id: 'Puck', label: 'Puck · Energetic', preview_url: 'voice-previews/puck.wav' },
      { id: 'Charon', label: 'Charon · Deep', preview_url: 'voice-previews/charon.wav' },
      { id: 'Orus', label: 'Orus · Calm', preview_url: 'voice-previews/orus.wav' },
      { id: 'voiceA', label: 'Anime Narrator', preview_url: 'voice-previews/voicea.wav' },
    ],
    voice_default: 'Kore',
    output_durations: [30, 60, 90],
    aspect_ratios: ['9:16', '1:1', '16:9'],
    // Conservative cents-rule pricing after moving TTS + music to native Google billing. The
    // source term covers the low-resolution full-video pass; the output term covers dense scene
    // verification, narration, and composition. The floor protects short uploads' fixed calls.
    pricing: {
      source_minute_credits: 1,
      output_second_credits: 1,
      minimum_credits: 55,
      music_credits: 4,
    },
    sheet: {
      description: 'Turn any video into a narrated summary.',
      preparing_label: 'Finding the story…',
    },
  },
  {
    format_id: 'daily-verse',
    title: 'Daily Verse',
    subtitle: 'A daily scripture story, brought to life',
    section: 'formats',
    sort_order: 20,
    status: 'soon',
    tile: {},
  },
  {
    format_id: 'spanish-lessons',
    title: 'Spanish Lessons',
    subtitle: 'Short visual lessons that make Spanish stick',
    section: 'formats',
    sort_order: 30,
    status: 'soon',
    tile: {},
  },
  {
    format_id: 'history-reimagined',
    title: 'History Reimagined',
    subtitle: 'Cinematic stories that put you inside the past',
    section: 'formats',
    sort_order: 40,
    status: 'soon',
    tile: {},
  },
];

export const VIDEO_SUMMARY_FORMAT = SERVER_FORMATS.find((format): format is VideoSummaryFormatDef => (
  format.status === 'live' && 'flow' in format && format.flow === 'video_summary'
));

function isGeneratedFormat(def: AnyFormatDef): def is FormatDef {
  return def.status === 'live' && !('flow' in def);
}

// Only live rows enter provider/billing resolution. SOON rows remain client-visible below.
export const FORMATS_BY_ID: Record<string, FormatDef> = Object.fromEntries(
  SERVER_FORMATS
    .filter(isGeneratedFormat)
    .map((format) => [format.format_id, format]),
);

export type ClientLiveFormatDef = Omit<
  FormatDef,
  | 'script_template'
  | 'image_model'
  | 'omni_model'
  | 'tts_model'
  | 'music_model'
  | 'style_grid'
> & {
  style_grid: Array<Omit<FormatStyleOption, 'anchor_r2_key'>>;
};
export type ClientFormatDef = ClientLiveFormatDef | VideoSummaryFormatDef | SoonFormatDef;

/**
 * Client-facing projection. Server prompt IP, provider routing, and private R2
 * anchor keys are removed before a route serializer can touch the registry.
 */
export const CLIENT_FORMATS: ClientFormatDef[] = SERVER_FORMATS.map((def) => {
  if (def.status === 'soon') {
    return def;
  }
  if ('flow' in def) {
    return def;
  }

  const {
    script_template,
    image_model,
    omni_model,
    tts_model,
    music_model,
    style_grid,
    ...rest
  } = def;

  return {
    ...rest,
    style_grid: style_grid.map(({ anchor_r2_key, ...styleRest }) => styleRest),
  };
});
