// src/config/formats.ts
//
// Server-driven formats registry. Pipeline code resolves a format row by id instead of
// hardcoding Explainer-specific provider, pricing, or presentation configuration.

export const FORMATS_VERSION = 1;

// ─── Typed segments (formats-ready constraint 1 — Phase 16 adds vocab/drill consumers) ───
export type FormatSegmentType = 'dialogue' | 'vocab' | 'drill';
export type FormatTextZone = 'lower_third' | 'upper_third' | 'center';
export type FormatAspectRatio = '9:16' | '16:9'; // D-10 — Omni supports ONLY these; 1:1 dropped

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
   * scene's candidate-still call. CLIENT_FORMATS strips this key before serialization.
   */
  anchor_r2_key: string;
}

export interface FormatVoiceOption {
  id: string;
  label: string;
}

export interface FormatDurationTier {
  seconds: 20 | 30 | 45 | 60 | 90;
  scene_count: number;
  credits: number;
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

export interface FormatDef {
  format_id: string;
  title: string;
  subtitle?: string;
  section: string;
  badge?: string;
  sort_order: number;
  status: 'live' | 'soon';
  tile: { poster_url?: string; loop_url?: string };
  /** SERVER-ONLY. System prompt template and allowed segment types for the script stage. */
  script_template: {
    system_prompt: string;
    segment_types_allowed: FormatSegmentType[];
  };
  /** SERVER-ONLY provider model ids. Config-driven so provider hosting remains swappable. */
  image_model: string;
  omni_model: string;
  tts_model: string;
  music_model: string;
  /** SERVER-ONLY. Candidate still count; only the vision-picked winner is animated. */
  candidate_still_count: number;
  style_grid: FormatStyleOption[];
  voices: FormatVoiceOption[];
  voice_default: string;
  music_moods: string[];
  aspect_ratios: FormatAspectRatio[];
  caption_style: FormatCaptionConfig;
  duration_tiers: FormatDurationTier[];
  sheet: FormatSheetMeta;
}

export const SERVER_FORMATS: FormatDef[] = [
  {
    format_id: 'explainer',
    title: 'Explainer',
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
    },
    image_model: 'openai/gpt-image-2-medium',
    omni_model: 'google/gemini-omni-flash/image-to-video',
    tts_model: 'fal-ai/gemini-3.1-flash-tts',
    music_model: 'fal-ai/lyria2',
    candidate_still_count: 3,
    style_grid: [
      {
        id: 'pixel-art',
        label: 'Pixel Art',
        thumb_url: 'formats/style-thumbs/pixel-art.jpg',
        anchor_r2_key: 'formats/style-anchors/pixel-art.png',
      },
      {
        id: 'claymation',
        label: 'Claymation',
        thumb_url: 'formats/style-thumbs/claymation.jpg',
        anchor_r2_key: 'formats/style-anchors/claymation.png',
      },
      {
        id: 'flat-vector',
        label: 'Flat Vector',
        thumb_url: 'formats/style-thumbs/flat-vector.jpg',
        anchor_r2_key: 'formats/style-anchors/flat-vector.png',
      },
      {
        id: 'doodle-chalkboard',
        label: 'Doodle',
        thumb_url: 'formats/style-thumbs/doodle-chalkboard.jpg',
        anchor_r2_key: 'formats/style-anchors/doodle-chalkboard.png',
      },
      {
        id: '3d-cartoon',
        label: '3D Cartoon',
        thumb_url: 'formats/style-thumbs/3d-cartoon.jpg',
        anchor_r2_key: 'formats/style-anchors/3d-cartoon.png',
      },
      {
        id: 'mixed-media',
        label: 'Mixed Media',
        thumb_url: 'formats/style-thumbs/mixed-media.jpg',
        anchor_r2_key: 'formats/style-anchors/mixed-media.png',
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
    duration_tiers: [
      { seconds: 20, scene_count: 3, credits: 325 },
      { seconds: 30, scene_count: 4, credits: 470 },
      { seconds: 45, scene_count: 6, credits: 693 },
      { seconds: 60, scene_count: 9, credits: 930 },
      { seconds: 90, scene_count: 13, credits: 1377 },
    ],
    sheet: {
      description: 'Type a topic — get a narrated, animated explainer video.',
      preparing_label: 'Writing your script…',
    },
  },
];

export const FORMATS_BY_ID: Record<string, FormatDef> = Object.fromEntries(
  SERVER_FORMATS.map((format) => [format.format_id, format]),
);

export type ClientFormatDef = Omit<
  FormatDef,
  | 'script_template'
  | 'image_model'
  | 'omni_model'
  | 'tts_model'
  | 'music_model'
  | 'candidate_still_count'
  | 'style_grid'
> & {
  style_grid: Array<Omit<FormatStyleOption, 'anchor_r2_key'>>;
};

/**
 * Client-facing projection. Server prompt IP, provider routing, candidate count, and private R2
 * anchor keys are removed before a route serializer can touch the registry.
 */
export const CLIENT_FORMATS: ClientFormatDef[] = SERVER_FORMATS.map((def) => {
  const {
    script_template,
    image_model,
    omni_model,
    tts_model,
    music_model,
    candidate_still_count,
    style_grid,
    ...rest
  } = def;

  return {
    ...rest,
    style_grid: style_grid.map(({ anchor_r2_key, ...styleRest }) => styleRest),
  };
});
