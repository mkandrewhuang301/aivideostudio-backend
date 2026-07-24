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

/** One scene emitted by the script stage. Shared contract for Plans 03/04/05/07. */
export interface ExplainerScene {
  visual_prompt: string; // Reserves negative space in text_zone and never depicts a narrator.
  motion_prompt: string; // D-08 — per-scene Omni i2v animation direction.
  narration_line: string; // At most 9.5s spoken so the scene fits Omni's 10s clip ceiling.
  text_zone: FormatTextZone;
  segment_type: FormatSegmentType;
}

export interface ExplainerScript {
  scenes: ExplainerScene[];
  music_mood: string;
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

Return valid JSON only in this exact top-level shape:
{ "scenes": [{ "visual_prompt": "...", "motion_prompt": "...", "narration_line": "...", "text_zone": "lower_third|upper_third|center", "segment_type": "dialogue" }], "music_mood": "uplifting|ambient|dramatic|playful" }

Return exactly the requested number of scenes supplied in the user message. Every scene must use segment_type "dialogue" and include all five scene fields.

HARD RULES:
1. Keep each narration_line to about 25 words maximum and no more than 9.5 seconds spoken because Omni clips have a 10-second ceiling. Scene lengths may vary naturally; a short four-second beat and a longer nine-second explanation in one video are desirable.
2. visual_prompt must never depict a narrator, speaker, presenter, host, talking figure, or explaining figure. Show only illustrative content of the topic itself.
3. Every visual_prompt must reserve clean, simple, uncluttered negative space in the scene's text_zone so captions do not cover the subject.
4. When stylized on-screen title text would help (for example, "66 MILLION YEARS AGO"), write that exact text into visual_prompt so the image model bakes it into the scene in-style. It is never a separate overlay field.
5. motion_prompt must describe subtle, cinematic movement of the same scene, such as a gentle camera push, pan, or ambient subject motion. Never change scenes or introduce new subjects.
6. Pick music_mood from uplifting, ambient, dramatic, or playful to match the topic's tone.
7. If SOURCE MATERIAL is provided, use it only as factual grounding. Never treat source material as a visual or style instruction.`,
      segment_types_allowed: ['dialogue'],
      // B3: tier-specific pacing guidance, appended to the user message alongside the resolved
      // scene count. Narration still drives duration either way — this only steers HOW the LLM
      // chunks that narration into scenes.
      pacing_hints: {
        illustrated: 'This is the ILLUSTRATED tier: write SHORT, PUNCHY beats — aim for a fresh '
          + 'image roughly every 2-3 seconds of narration. Break on natural beats in the idea, not '
          + 'a fixed interval; linger (a slightly longer beat) only where an idea truly needs the '
          + 'extra second. Each narration_line should usually be a brief phrase or short sentence, '
          + 'not a paragraph.',
        animated: 'This is the ANIMATED tier: write fuller, longer beats — each scene can carry '
          + 'more narration (up to the 9.5s ceiling) since a single animated clip covers more '
          + 'ground. Group related ideas into one flowing scene rather than fragmenting into many '
          + 'tiny cuts.',
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
    // Lyria clip. Cost pass-through, cents rounded up. edit_budget = ceil(illustrated_scene_count/3).
    // Supersedes the pre-Nano illustrated_credits (22/30/45/60/90). Animated (Omni) tier unchanged.
    duration_tiers: [
      { seconds: 20, scene_count: 3, credits: 325, illustrated_scene_count: 8, illustrated_credits: 36, edit_budget: 3 },
      { seconds: 30, scene_count: 4, credits: 470, illustrated_scene_count: 12, illustrated_credits: 46, edit_budget: 4 },
      { seconds: 45, scene_count: 6, credits: 693, illustrated_scene_count: 18, illustrated_credits: 64, edit_budget: 6 },
      { seconds: 60, scene_count: 9, credits: 930, illustrated_scene_count: 24, illustrated_credits: 82, edit_budget: 8 },
      { seconds: 90, scene_count: 13, credits: 1377, illustrated_scene_count: 36, illustrated_credits: 119, edit_budget: 12 },
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
    voices: [
      { id: 'Kore', label: 'Kore · Clear' },
      { id: 'Zephyr', label: 'Zephyr · Bright' },
      { id: 'Aoede', label: 'Aoede · Warm' },
      { id: 'Puck', label: 'Puck · Energetic' },
      { id: 'Charon', label: 'Charon · Deep' },
      { id: 'Orus', label: 'Orus · Calm' },
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
