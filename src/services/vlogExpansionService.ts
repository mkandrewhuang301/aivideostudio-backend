// Character-vlog expansion pass (v1 one-shot, 2026-07-25 lock — SUPERSEDES the 7/24 Sonnet
// multi-take planner, shelved in the descope: "too much trying to oneshot this stuff").
//
// ONE cheap LLM call turns the user's single beat into { enhancedPrompt, spokenLine }:
//   - enhancedPrompt: the beat visually ENRICHED into one continuous shot (setting, props,
//     action) — the arm-A scene-collapse mitigation lives here, not in a still stage.
//   - spokenLine: the character's single line, ~2.5 words/sec × duration. User-quoted dialogue
//     in the beat is extracted IN CODE and pinned verbatim (the LLM paraphrases quotes — same
//     finding as openaiScriptService's script expansion). Silent beats get "" — the worker
//     then skips the qwen TTS stage and sends Mini no reference_audios.
//
// FAIL-CLOSED with NO repair pass (descope: one-shot failures are cheap and user-facing, the
// worker refunds) — invalid JSON or a blown word budget throws.

import type { CharacterVlogConfig } from '../config/characters';
import { config } from '../config';
import { generateClaudeText, type ClaudeEffort } from './providers/ReplicateProvider';

// Default lives in config.vlogExpansionModel (sonnet-5/effort-low). claude-haiku-4.5 is NOT on
// Replicate and claude-3.5-haiku 500'd consistently at build time (both verified 2026-07-25) —
// 3.5-haiku stays the env-flippable cheap fallback, but its schema has no `effort` param, so
// it's the one model we must not send it to.
const EFFORTLESS_MODELS = new Set(['anthropic/claude-3.5-haiku']);
const VLOG_EXPANSION_EFFORT: ClaudeEffort = 'low';
const VLOG_EXPANSION_MAX_TOKENS = 1024;

const WORDS_PER_SECOND = 2.5;

export interface VlogExpansion {
  enhancedPrompt: string;
  /** '' = silent beat — no TTS, no reference_audios. */
  spokenLine: string;
  /** True when the line came verbatim from user-quoted dialogue (budget-exempt). */
  linePinnedByUser: boolean;
}

/**
 * User-quoted dialogue = verbatim spoken_line (spec). Straight or curly double quotes only —
 * single quotes false-positive on apostrophes ("don't"). First span wins.
 */
export function extractQuotedLine(beat: string): string | null {
  const match = beat.match(/"([^"\n]+)"|“([^”\n]+)”/);
  const quoted = (match?.[1] ?? match?.[2])?.trim();
  return quoted || null;
}

function wordBudgetFor(seconds: number): number {
  return Math.floor(WORDS_PER_SECOND * seconds);
}

function countWords(line: string): number {
  return line.trim() ? line.trim().split(/\s+/).length : 0;
}

function buildSystemPrompt(character: CharacterVlogConfig, durationSeconds: number): string {
  return `You are the director for a fictional character vlogger's one-shot vlog clip.
Persona: ${character.persona_prompt}
Framing (every clip starts from this): ${character.vlog_framing_prefix}

The user gives you ONE beat. You turn it into a video-model prompt for ONE continuous shot — no cuts, no scene changes, no time skips — plus the character's single spoken line.

Rules:
- enhanced_prompt: open with the framing above, then describe the single shot vividly and concretely — setting, props, lighting, the character's action and gestures. Enrich the scene generously: the video model only shows what the prompt describes, and a thin prompt collapses to a generic room. Stay strictly on the user's beat.
- Do NOT put the spoken words inside enhanced_prompt — the line travels separately.
- spoken_line: verbatim first-person speech, in persona, no stage directions, no quoted-aside narration. Budget: ≤ ${wordBudgetFor(durationSeconds)} words (spoken at ~${WORDS_PER_SECOND} words/sec over ${durationSeconds}s).
- If the beat implies the character does NOT speak (silent reaction, visual gag, montage), spoken_line is "".
- Keep everything original: no real people, no copyrighted characters, no brand names.

Output ONLY a JSON object (no markdown fences):
{ "enhanced_prompt": "...", "spoken_line": "..." }`;
}

/** Strips the markdown fences Claude occasionally wraps around bare JSON (explainer idiom). */
function parseExpansion(raw: string): { enhancedPrompt: string; spokenLine: string } | null {
  const content = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  if (!content) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const enhancedPrompt = typeof parsed.enhanced_prompt === 'string' ? parsed.enhanced_prompt.trim() : '';
  const spokenLine = typeof parsed.spoken_line === 'string' ? parsed.spoken_line.trim() : '';
  if (!enhancedPrompt) return null;
  return { enhancedPrompt, spokenLine };
}

/** Over-budget LLM line → trim to the last sentence boundary inside budget; throw if none
 *  (a mid-sentence cut would ship broken speech through the clone). User-pinned lines are
 *  exempt — verbatim beats budget (spec). */
function enforceWordBudget(line: string, durationSeconds: number): string {
  const budget = wordBudgetFor(durationSeconds);
  if (countWords(line) <= budget) return line;
  const sentences = line.match(/[^.!?]+[.!?]+/g) ?? [];
  let kept = '';
  for (const sentence of sentences) {
    if (countWords(kept + sentence) > budget) break;
    kept += sentence;
  }
  kept = kept.trim();
  if (!kept) {
    throw new Error(`vlog expansion line is ${countWords(line)} words with no sentence boundary inside the ${budget}-word budget`);
  }
  return kept;
}

/**
 * The one expansion pass. Throws on any failure — the worker's catch marks failed + refunds.
 */
export async function expandVlogBeat(args: {
  character: CharacterVlogConfig;
  beat: string;
  durationSeconds: number;
}): Promise<VlogExpansion> {
  const pinnedLine = extractQuotedLine(args.beat);
  const raw = await generateClaudeText(config.vlogExpansionModel, {
    systemPrompt: buildSystemPrompt(args.character, args.durationSeconds),
    prompt: `Beat: ${args.beat}${pinnedLine
      ? '\n\nThe user quoted their exact dialogue in the beat — it will be used VERBATIM as the spoken line. Write only enhanced_prompt; set spoken_line to "".'
      : ''}`,
    maxTokens: VLOG_EXPANSION_MAX_TOKENS,
    ...(EFFORTLESS_MODELS.has(config.vlogExpansionModel) ? {} : { effort: VLOG_EXPANSION_EFFORT }),
  });
  const parsed = parseExpansion(raw);
  if (!parsed) throw new Error('vlog expansion returned no usable JSON');

  if (pinnedLine) {
    return { enhancedPrompt: parsed.enhancedPrompt, spokenLine: pinnedLine, linePinnedByUser: true };
  }
  return {
    enhancedPrompt: parsed.enhancedPrompt,
    spokenLine: parsed.spokenLine ? enforceWordBudget(parsed.spokenLine, args.durationSeconds) : '',
    linePinnedByUser: false,
  };
}

/**
 * The exact Mini prompt for the clip — persisted verbatim on the take unit (user-visible on
 * the detail/regen screen, per the 7/24 regen-visibility lock). The spoken line rides as
 * quoted dialogue so Mini speaks it even without the audio pin; with the pin, the qwen clone
 * audio drives voice + lip-sync and this keeps the model on-script.
 */
export function buildClipPrompt(character: CharacterVlogConfig, expansion: VlogExpansion): string {
  if (!expansion.spokenLine) return expansion.enhancedPrompt;
  return `${expansion.enhancedPrompt}
Speaking the following as spoken dialogue, ${character.default_voice_direction}: "${expansion.spokenLine}"`;
}
