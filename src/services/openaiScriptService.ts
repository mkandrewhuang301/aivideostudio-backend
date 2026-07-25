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
import { generateClaudeText } from './providers/ReplicateProvider';
import type {
  ExplainerScene,
  ExplainerScript,
  ExplainerVisualMethod,
  FormatDef,
  FormatSegmentType,
  FormatTextZone,
  SceneMotion,
  SceneMotionType,
} from '../config/formats';
import { sanitizeMotion } from '../config/formats';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const SCRIPT_EXPANSION_MODEL = 'gpt-4o-mini';
// Explainer script runs on Claude Sonnet 5 via Replicate (2026-07-24 swap off gpt-4o — the
// factual-hallucination fix; see generateClaudeText). gpt-4o-mini stays on the cheap mechanical
// paths (prompt intelligence, vlog expansion) where factual care doesn't matter.
const EXPLAINER_SCRIPT_MODEL = 'anthropic/claude-sonnet-5';
// Claude bills thinking tokens as output, so the cap must cover effort:'medium' reasoning + the
// ~2k-token script JSON (gpt-4o's 2000 was output-only).
const EXPLAINER_SCRIPT_MAX_TOKENS = 8_000;
const MAX_TOKENS = 400;
const TEMPERATURE = 0.7;
const EXPLAINER_MUSIC_MOODS = new Set(['uplifting', 'ambient', 'dramatic', 'playful']);
const FORMAT_TEXT_ZONES = new Set<FormatTextZone>(['lower_third', 'upper_third', 'center']);
const BANNED_NARRATOR_FIGURE = /(a |the )?(narrator|presenter|host|talking head|speaker)( figure| standing| talking| explaining)?/gi;
const SCENE_MOTION_TYPES = new Set<SceneMotionType>([
  'ken_burns', 'wiggle', 'reaction', 'before_after', 'progressive_reveal', 'ambient_life',
]);
const TRANSITION_OUTS = new Set(['cut', 'morph']);
const DEFAULT_SCENE_MOTION: SceneMotion = { type: 'ken_burns', priority: 2, edit_steps: [] };
const MAX_EDIT_STEPS = 3;

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
  /**
   * EXPECTED scene count for this tier — script-first (2026-07-24): no longer a hard instruction
   * to the LLM, which derives the real count from natural beat boundaries. Used only for the
   * sanity clamp (~1.75x) and the fallback budget estimate when targetTotalSeconds is omitted.
   */
  sceneCount: number;
  styleLabel: string;
  scriptTemplate: FormatDef['script_template'];
  /** Factual source material only; never a visual or style instruction. */
  groundingText?: string;
  /**
   * Which visual-method tier's pacing_hint to inject (illustrated = many short punchy beats,
   * animated = fewer fuller beats). Optional so pre-existing callers/tests keep compiling; defaults
   * to 'illustrated'.
   */
  visualMethod?: ExplainerVisualMethod;
  /**
   * TOTAL spoken-duration budget in seconds (PRE any post-synthesis atempo stretch) that all
   * narration_lines combined should sum to. This is the actual fix for v3's 77s-for-a-30s-tier
   * overshoot: the old prompt only bounded a PER-SCENE ceiling (25 words / 9.5s), so a 12-scene
   * script could legally write up to 12*9.5s of narration. Optional so pre-existing callers/tests
   * keep compiling; when omitted, falls back to a generous per-scene estimate that reproduces the
   * old unconstrained behavior (real callers always pass this explicitly).
   */
  targetTotalSeconds?: number;
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
      motion: { ...DEFAULT_SCENE_MOTION },
      transition_out: 'cut',
    }],
    music_mood: 'ambient',
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parses+validates the `motion` object the script LLM is asked to emit per scene. Any malformed
 * or missing shape falls back to the DEFAULT_SCENE_MOTION (ken_burns, priority 2, no nano edits) —
 * a bad motion object must never fail the whole scene. edit_steps is clamped to MAX_EDIT_STEPS and
 * sanitized through the same narrator-figure guard as visual_prompt.
 */
function parseSceneMotion(value: unknown): SceneMotion {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SCENE_MOTION };

  const motion = value as Record<string, unknown>;
  const type = nonEmptyString(motion.type) && SCENE_MOTION_TYPES.has(motion.type as SceneMotionType)
    ? motion.type as SceneMotionType
    : DEFAULT_SCENE_MOTION.type;

  const rawPriority = typeof motion.priority === 'number' ? motion.priority : Number(motion.priority);
  const priority = Number.isFinite(rawPriority)
    ? Math.min(5, Math.max(1, Math.round(rawPriority)))
    : DEFAULT_SCENE_MOTION.priority;

  const rawSteps = Array.isArray(motion.edit_steps) ? motion.edit_steps : [];
  const editSteps = rawSteps
    .filter(nonEmptyString)
    .map((step) => step.trim().replace(BANNED_NARRATOR_FIGURE, 'the subject'))
    .slice(0, MAX_EDIT_STEPS);

  // sanitizeMotion is the retired-progressive_reveal safety net (2026-07-23): the script LLM is no
  // longer offered it, but this normalizes any that still shows up (old data, a malformed
  // completion) to ken_burns so it can never be chosen or rendered.
  return sanitizeMotion({ type, priority, edit_steps: editSteps });
}

function parseExplainerScene(
  value: unknown,
  allowedSegmentTypes: FormatSegmentType[],
): ExplainerScene | null {
  if (!value || typeof value !== 'object') return null;

  const scene = value as Record<string, unknown>;
  // Script-first (2026-07-24): the LLM emits narration_segment (a verbatim slice of full_script).
  // narration_line is accepted as a legacy fallback so a completion that ignored the new schema
  // still parses instead of falling to the single-scene fallback.
  const narration = nonEmptyString(scene.narration_segment)
    ? scene.narration_segment
    : scene.narration_line;
  if (
    !nonEmptyString(scene.visual_prompt)
    || !nonEmptyString(scene.motion_prompt)
    || !nonEmptyString(narration)
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
  const transitionOut = nonEmptyString(scene.transition_out) && TRANSITION_OUTS.has(scene.transition_out)
    ? scene.transition_out as 'cut' | 'morph'
    : 'cut';

  return {
    visual_prompt: scene.visual_prompt.trim().replace(BANNED_NARRATOR_FIGURE, 'the subject'),
    motion_prompt: scene.motion_prompt.trim(),
    narration_line: narration.trim(),
    text_zone: textZone,
    segment_type: segmentType,
    motion: parseSceneMotion(scene.motion),
    transition_out: transitionOut,
  };
}

/** Whitespace-normalized comparison form for the full_script ↔ segments consistency check. */
function normalizeScriptText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Re-flows an authoritative full_script into `groupCount` contiguous narration lines when the
 * model's own segmentation drifted (segments don't re-join to full_script). Splits on sentence
 * boundaries and packs sentences into groups of roughly equal word count; falls back to an even
 * word split when there are fewer sentences than groups. Returns null when full_script is empty.
 */
export function reflowFullScript(fullScript: string, groupCount: number): string[] | null {
  const normalized = normalizeScriptText(fullScript);
  if (!normalized || groupCount < 1) return null;
  if (groupCount === 1) return [normalized];

  const sentences = normalized.match(/[^.!?]+[.!?]+(?:["')\]]+)?/g)?.map((s) => s.trim())
    .filter((s) => s.length > 0) ?? [];

  if (sentences.length < groupCount) {
    // Not enough sentence boundaries — split the word stream into even contiguous groups.
    const words = normalized.split(' ');
    const perGroup = Math.ceil(words.length / groupCount);
    const groups: string[] = [];
    for (let i = 0; i < words.length; i += perGroup) {
      groups.push(words.slice(i, i + perGroup).join(' '));
    }
    return groups;
  }

  // Greedy balanced packing: target ~equal words per group, never breaking a sentence.
  const totalWords = sentences.reduce((sum, s) => sum + s.split(' ').length, 0);
  const target = totalWords / groupCount;
  const groups: string[] = [];
  let current: string[] = [];
  let currentWords = 0;
  let groupsLeft = groupCount - 1;
  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = sentences[i]!;
    const words = sentence.split(' ').length;
    const sentencesLeftAfter = sentences.length - i - 1;
    if (
      current.length > 0
      && currentWords + words > target
      && groupsLeft > 0
      && sentencesLeftAfter >= groupsLeft
    ) {
      groups.push(current.join(' '));
      current = [];
      currentWords = 0;
      groupsLeft -= 1;
    }
    current.push(sentence);
    currentWords += words;
  }
  groups.push(current.join(' '));
  return groups;
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
    const visualMethod = args.visualMethod ?? 'illustrated';
    const pacingHint = args.scriptTemplate.pacing_hints[visualMethod];
    // Script-first (2026-07-24): the budget bounds full_script as a WHOLE. sceneCount is now only
    // an EXPECTED count (for the sanity clamp + budget estimate) — the prompt asks for beats of a
    // target length and lets the count emerge, never a hard "return exactly N scenes" (which is
    // what produced the telegraphic 12-fragment scripts).
    const targetTotalSeconds = args.targetTotalSeconds && args.targetTotalSeconds > 0
      ? args.targetTotalSeconds
      : args.sceneCount * DEFAULT_CLIP_SECONDS;
    const totalWordBudget = Math.max(
      args.sceneCount * 3,
      Math.round(targetTotalSeconds * WORDS_PER_SECOND),
    );
    const budgetBlock = `\n\nPACING GUIDANCE: ${pacingHint}\n\nTOTAL NARRATION BUDGET: full_script `
      + `should be about ${totalWordBudget} words total (~${Math.round(targetTotalSeconds)}s of `
      + `natural speech at roughly ${WORDS_PER_SECOND} words/sec). This is a TOTAL for the whole `
      + 'video. At the beat length in the pacing guidance above, that usually lands somewhere '
      + `around ${args.sceneCount} scenes — an estimate, NOT a target. Write the script to the word `
      + 'budget, break it at natural boundaries, and let the scene count fall where it falls.';
    let rawContent: string;
    try {
      rawContent = await generateClaudeText(EXPLAINER_SCRIPT_MODEL, {
        systemPrompt: args.scriptTemplate.system_prompt,
        prompt: `Topic: ${args.topic}\nVisual style: ${args.styleLabel}${budgetBlock}${groundingBlock}`,
        maxTokens: EXPLAINER_SCRIPT_MAX_TOKENS,
        // effort 'medium' is the accuracy lever — the whole point of the swap off gpt-4o is
        // factual care in visual_prompts (era/subject/count details), which lives in thinking.
        effort: 'medium',
      });
    } catch (error) {
      console.error('[openaiScriptService] Explainer completion unavailable, using structural fallback:', error);
      return explainerFallback(args);
    }

    // Replicate exposes no structured-output param, so the JSON contract is prompt discipline;
    // strip the markdown fences Claude occasionally wraps around bare JSON before validating.
    const content = rawContent.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
    if (!content) return explainerFallback(args);

    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!Array.isArray(parsed.scenes)) return explainerFallback(args);

    // Sanity band: the count is emergent, but a runaway completion (40 scenes for a 30s tier)
    // would blow the per-video still/TTS cost — clamp the top at ~1.75x the tier's expected count.
    const maxScenes = Math.max(4, Math.ceil(args.sceneCount * 1.75));
    const scenes = parsed.scenes
      .map((scene) => parseExplainerScene(scene, args.scriptTemplate.segment_types_allowed))
      .filter((scene): scene is ExplainerScene => scene !== null)
      .slice(0, maxScenes);
    if (scenes.length === 0) return explainerFallback(args);

    // full_script ↔ segments consistency check (script-first contract): concatenating the
    // narration segments in order must reproduce full_script. On drift, full_script is
    // AUTHORITATIVE — re-flow it across the parsed scenes (keeping their visuals/motion) rather
    // than trusting paraphrased segments. Missing full_script degrades to the joined segments.
    let fullScript = nonEmptyString(parsed.full_script)
      ? normalizeScriptText(parsed.full_script)
      : normalizeScriptText(scenes.map((scene) => scene.narration_line).join(' '));
    const joinedSegments = normalizeScriptText(scenes.map((scene) => scene.narration_line).join(' '));
    if (fullScript !== joinedSegments) {
      const reflowed = nonEmptyString(parsed.full_script)
        ? reflowFullScript(parsed.full_script, scenes.length)
        : null;
      if (reflowed && reflowed.length === scenes.length) {
        console.warn('[openaiScriptService] narration segments drifted from full_script; re-flowing full_script across scenes');
        scenes.forEach((scene, index) => {
          scene.narration_line = reflowed[index]!;
        });
        fullScript = normalizeScriptText(reflowed.join(' '));
      } else {
        console.warn('[openaiScriptService] full_script missing/unusable for re-flow; keeping model segmentation as-is');
      }
    }

    return {
      scenes,
      music_mood: nonEmptyString(parsed.music_mood) && EXPLAINER_MUSIC_MOODS.has(parsed.music_mood)
        ? parsed.music_mood
        : 'ambient',
      full_script: fullScript,
    };
  } catch (err) {
    console.error('[openaiScriptService] Explainer completion unavailable, using structural fallback:', err);
    return explainerFallback(args);
  }
}
