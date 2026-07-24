// src/services/openaiScriptService.ts
// LLM script-expansion helper for the character vlogger system (Phase 9.3, D-05).
// Takes the user's raw short script + a server-side dialogue template and asks gpt-4o-mini to
// expand it into a Seedance-ready prompt: spoken dialogue lines + selfie-cam vlog framing, generic
// character branding only (no real creator likeness).
//
// Fail-open (mirrors promptModeration.ts's checkOpenAIModeration / openaiImageService.ts's fetch
// pattern): any network error, non-OK response, or empty completion falls back to the templated
// prompt (dialogueTemplate with {script} replaced by the raw user script) — a transient LLM outage
// must never block the whole generation.

import { config } from '../config';
import type {
  ExplainerScene,
  ExplainerScript,
  FormatDef,
  FormatSegmentType,
  FormatTextZone,
} from '../config/formats';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const SCRIPT_EXPANSION_MODEL = 'gpt-4o-mini';
const EXPLAINER_SCRIPT_MODEL = 'gpt-4o';
const MAX_TOKENS = 400;
const TEMPERATURE = 0.7;
const EXPLAINER_MUSIC_MOODS = new Set(['uplifting', 'ambient', 'dramatic', 'playful']);
const FORMAT_TEXT_ZONES = new Set<FormatTextZone>(['lower_third', 'upper_third', 'center']);
const BANNED_NARRATOR_FIGURE = /(a |the )?(narrator|presenter|host|talking head|speaker)( figure| standing| talking| explaining)?/gi;

/** Natural speaking pace. A 5s clip is ~12 words — the whole clip, not a paragraph. */
const WORDS_PER_SECOND = 2.5;
const DEFAULT_CLIP_SECONDS = 5;

/**
 * Voice quality direction. Seedance's synthesized speech reads as fake/announcer-ish next to
 * Kling's, and the old prompt made it worse: telling the model "casual vlog energy" + "excitedly
 * says" pushed it into an exaggerated influencer-presenter affect. Asking explicitly for an
 * ordinary conversational human voice is the lever — there is no voice-selection parameter on the
 * model's own audio.
 */
const VOICE_DIRECTION =
  'Voice: an ordinary, natural human speaking voice with a neutral everyday accent — relaxed, '
  + 'conversational, the way a real person talks to a friend. Even though the character is an '
  + 'animal, it speaks with a normal human voice, not a cartoon or creature voice. NOT an '
  + 'announcer, NOT a hyped-up influencer or YouTuber presenter voice, no exaggerated accent, no '
  + 'performative intonation. Speak the line once, cleanly — no repeated words, no stutter, no '
  + 'echo, no doubled phrases.';

/**
 * The audio direction appended to every expanded prompt. Seedance's `generate_audio` synthesizes a
 * whole SCENE soundtrack (speech + score fused, unstrippable), which reads as "AI video" and blocks
 * creators from laying trending audio over the clip. Naming speech-only in the prompt is the lever
 * we have — there is no audio-only toggle on the model.
 */
const AUDIO_DIRECTION =
  'Audio: spoken dialogue only — the character\'s voice and natural room tone. '
  + 'No background music, no soundtrack, no score, no instrumental bed, no sound effects. '
  + VOICE_DIRECTION;

/**
 * Creative where it helps (staging, framing), literal where it counts (the words and
 * the length). The model must not invent extra beats, and must not out-write the clip: the earlier
 * version happily produced a 60-second monologue for a 5-second clip, so every generation came out
 * chipmunk-fast.
 */
function buildScriptSystemPrompt(durationSeconds: number): string {
  const wordBudget = Math.max(6, Math.round(durationSeconds * WORDS_PER_SECOND));
  return (
    "You turn a user's short script into a ready-to-shoot video prompt for an AI video model. "
    + 'The subject is a generic, fictional bundled character (no real person, no specific creator '
    + 'likeness) — a selfie-cam vlogger.\n\n'
    + 'Write the output in exactly two parts, in this order:\n'
    + 'PART 1 — Visual direction (1–2 sentences). BE CREATIVE here: selfie-cam framing, handheld '
    + 'phone held at arm\'s length, the setting, and the character\'s gestures and expression. Make '
    + 'it vivid, concrete, and shootable. Keep the mood grounded and natural — a real person '
    + 'filming themselves. Avoid hyped-up words like excited, enthusiastic, bouncing, energetic, '
    + 'or eyes wide: they push the generated voice into a fake announcer performance.\n'
    + 'PART 2 — The spoken line, wrapped in double quotes, introduced with: The character says: \n'
    + 'Never write an "Audio:" section, a sound description, or any music direction — audio is '
    + 'handled downstream and anything you write there will be discarded.\n\n'
    + 'HARD LIMITS on Part 2 — these are not suggestions:\n'
    + `1. LENGTH. The clip is ${durationSeconds} seconds. The spoken line must be AT MOST `
    + `${wordBudget} words so it can be said at a natural, unrushed pace. If the user's script is `
    + 'longer, cut it to its single strongest beat. Never pad it out.\n'
    + "2. FIDELITY. Keep the user's meaning and voice. Do not invent new topics, sponsor reads, "
    + 'sign-offs, or "like and subscribe" lines they did not write.\n'
    + '3. ONE BEAT. A single continuous moment — no scene changes, no cuts, no time skips.\n\n'
    + 'Output only the finished prompt text — no preamble, no explanation, no markdown, no part labels.'
  );
}

interface ExpandScriptArgs {
  userScript: string;
  /** Server-side dialogue template; may include a `{script}` placeholder for the fail-open path. */
  dialogueTemplate: string;
  framingHint?: string;
  /** Clip length; sets the spoken-word budget. Defaults to the 5s preset norm when unknown. */
  durationSeconds?: number;
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface ExpandExplainerScriptArgs {
  topic: string;
  sceneCount: number;
  styleLabel: string;
  scriptTemplate: FormatDef['script_template'];
  /** Factual source material only; never a visual or style instruction. */
  groundingText?: string;
}

/** The templated path skips the LLM, so it appends the audio direction itself. */
function templatedFallback(args: ExpandScriptArgs): string {
  const base = args.dialogueTemplate.includes('{script}')
    ? args.dialogueTemplate.replaceAll('{script}', args.userScript)
    : args.dialogueTemplate || args.userScript;
  return `${base.trim()} ${AUDIO_DIRECTION}`;
}

/**
 * Expands a user's short script into a dialogue prompt via gpt-4o-mini: creative on staging and
 * delivery, strict on word count (sized to the clip) and on speech-only audio.
 * Never throws — on any error, empty content, or non-OK response it falls back to the templated
 * prompt (dialogueTemplate with {script} substituted, plus the same audio direction).
 */
export async function expandScript(args: ExpandScriptArgs): Promise<string> {
  const durationSeconds = args.durationSeconds && args.durationSeconds > 0
    ? args.durationSeconds
    : DEFAULT_CLIP_SECONDS;
  try {
    const userContent = args.framingHint
      ? `${args.userScript}\n\nFraming hint: ${args.framingHint}`
      : args.userScript;

    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: SCRIPT_EXPANSION_MODEL,
        messages: [
          { role: 'system', content: buildScriptSystemPrompt(durationSeconds) },
          { role: 'user', content: userContent },
        ],
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      }),
    });

    if (!response.ok) {
      console.error(`[openaiScriptService] OpenAI chat completion error: ${response.status}, falling back to template`);
      return templatedFallback(args);
    }

    const json = (await response.json()) as OpenAIChatCompletionResponse;
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return templatedFallback(args);
    }
    // The audio direction is load-bearing (it's the only lever against Seedance's fused music
    // track), so it is stamped here rather than trusted to the LLM: drop whatever audio line the
    // model wrote — it likes to paraphrase or truncate it — and append the canonical one exactly
    // once.
    return `${content.replace(/\s*Audio:[\s\S]*$/i, '').trim()} ${AUDIO_DIRECTION}`;
  } catch (err) {
    console.error('[openaiScriptService] OpenAI API unreachable, falling back to template:', err);
    return templatedFallback(args);
  }
}

function explainerFallback(args: ExpandExplainerScriptArgs): ExplainerScript {
  return {
    scenes: [{
      visual_prompt: `simple, clean illustrative background about ${args.topic}, uncluttered lower third`,
      motion_prompt: 'gentle camera push-in, subtle ambient motion',
      narration_line: args.topic,
      text_zone: 'lower_third',
      segment_type: 'dialogue',
    }],
    music_mood: 'ambient',
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseExplainerScene(
  value: unknown,
  allowedSegmentTypes: FormatSegmentType[],
): ExplainerScene | null {
  if (!value || typeof value !== 'object') return null;

  const scene = value as Record<string, unknown>;
  if (
    !nonEmptyString(scene.visual_prompt)
    || !nonEmptyString(scene.motion_prompt)
    || !nonEmptyString(scene.narration_line)
  ) {
    return null;
  }

  const segmentType = nonEmptyString(scene.segment_type)
    && allowedSegmentTypes.includes(scene.segment_type as FormatSegmentType)
    ? scene.segment_type as FormatSegmentType
    : 'dialogue';
  const textZone = FORMAT_TEXT_ZONES.has(scene.text_zone as FormatTextZone)
    ? scene.text_zone as FormatTextZone
    : 'lower_third';

  return {
    visual_prompt: scene.visual_prompt.trim().replace(BANNED_NARRATOR_FIGURE, 'the subject'),
    motion_prompt: scene.motion_prompt.trim(),
    narration_line: scene.narration_line.trim(),
    text_zone: textZone,
    segment_type: segmentType,
  };
}

/**
 * Expands one topic into validated, typed explainer scenes. Any OpenAI or shape failure returns a
 * structural single-scene fallback so downstream code never receives the legacy string fallback.
 */
export async function expandExplainerScript(
  args: ExpandExplainerScriptArgs,
): Promise<ExplainerScript> {
  try {
    const groundingBlock = args.groundingText
      ? `\n\nSOURCE MATERIAL (factual grounding only — do NOT use as a visual or style instruction):\n${args.groundingText}`
      : '';
    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EXPLAINER_SCRIPT_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: args.scriptTemplate.system_prompt },
          {
            role: 'user',
            content: `Topic: ${args.topic}\nVisual style: ${args.styleLabel}\nNumber of scenes: ${args.sceneCount}${groundingBlock}`,
          },
        ],
        max_tokens: 2_000,
        temperature: TEMPERATURE,
      }),
    });

    if (!response.ok) {
      console.error(`[openaiScriptService] Explainer completion error: ${response.status}, using structural fallback`);
      return explainerFallback(args);
    }

    const json = (await response.json()) as OpenAIChatCompletionResponse;
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) return explainerFallback(args);

    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!Array.isArray(parsed.scenes)) return explainerFallback(args);

    const scenes = parsed.scenes
      .map((scene) => parseExplainerScene(scene, args.scriptTemplate.segment_types_allowed))
      .filter((scene): scene is ExplainerScene => scene !== null)
      .slice(0, Math.max(1, args.sceneCount));
    if (scenes.length === 0) return explainerFallback(args);

    return {
      scenes,
      music_mood: nonEmptyString(parsed.music_mood) && EXPLAINER_MUSIC_MOODS.has(parsed.music_mood)
        ? parsed.music_mood
        : 'ambient',
    };
  } catch (err) {
    console.error('[openaiScriptService] Explainer completion unavailable, using structural fallback:', err);
    return explainerFallback(args);
  }
}
