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

const SYSTEM_PROMPT =
  "You expand a user's short script into a ready-to-shoot video prompt for an AI video model. " +
  'The subject is a generic, fictional bundled character (no real person, no specific creator ' +
  'likeness) — a selfie-cam vlogger. Expand the user\'s script into natural spoken dialogue lines ' +
  'the character says on camera, plus brief selfie-cam vlog framing/staging description (handheld ' +
  'phone framing, casual vlog energy). Keep it concise, concrete, and shootable. Output only the ' +
  'expanded prompt text, no preamble or explanation.';

interface ExpandScriptArgs {
  userScript: string;
  /** Server-side dialogue template; may include a `{script}` placeholder for the fail-open path. */
  dialogueTemplate: string;
  framingHint?: string;
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

function templatedFallback(args: ExpandScriptArgs): string {
  return args.dialogueTemplate.includes('{script}')
    ? args.dialogueTemplate.replaceAll('{script}', args.userScript)
    : args.dialogueTemplate || args.userScript;
}

/**
 * Expands a user's short script into a Seedance-ready dialogue prompt via gpt-4o-mini.
 * Never throws — on any error, empty content, or non-OK response it falls back to the templated
 * prompt (dialogueTemplate with {script} substituted).
 */
export async function expandScript(args: ExpandScriptArgs): Promise<string> {
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
          { role: 'system', content: SYSTEM_PROMPT },
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
    return content;
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

/**
 * D-16 soft quality signal: choose one rendered still for Omni animation. Every failure falls back
 * to candidate zero so a vision-ranking outage can never fail the paid generation pipeline.
 */
export async function pickBestCandidateIndex(
  candidateUrls: string[],
  visualPrompt: string,
  textZone: FormatTextZone,
): Promise<number> {
  if (candidateUrls.length <= 1) return 0;

  try {
    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Pick the best still for this scene. Visual intent: "${visualPrompt}". Rubric: closest style match to the visual intent, NO narrator/presenter/speaker/host figure, cleanest uncluttered ${textZone} region reserved for captions. Reply ONLY JSON {"winner_index": N} — 0-based index into the images below, in the order given.`,
            },
            ...candidateUrls.map((url) => ({
              type: 'image_url',
              image_url: { url },
            })),
          ],
        }],
        max_tokens: 50,
        temperature: 0,
      }),
    });
    if (!response.ok) return 0;

    const data = (await response.json()) as OpenAIChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) return 0;

    const parsed = JSON.parse(content) as Record<string, unknown>;
    const index = parsed.winner_index;
    if (
      typeof index !== 'number'
      || !Number.isInteger(index)
      || index < 0
      || index >= candidateUrls.length
    ) {
      return 0;
    }
    return index;
  } catch {
    return 0;
  }
}
