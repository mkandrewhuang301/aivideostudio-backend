// Character-vlog expansion pass (v1 one-shot, 2026-07-25 lock — SUPERSEDES the 7/24 Sonnet
// multi-take planner, shelved in the descope: "too much trying to oneshot this stuff").
//
// ONE cheap LLM call turns the user's single beat into { enhancedPrompt, spokenLine, delivery }:
//   - enhancedPrompt: the beat visually ENRICHED into one continuous shot (setting, props,
//     action, camera behavior, the arc before/after the line) — the arm-A scene-collapse
//     mitigation lives here, not in a still stage.
//   - spokenLine: the character's single line, ~2.5 words/sec × duration. User-quoted dialogue
//     in the beat is extracted IN CODE and pinned verbatim (the LLM paraphrases quotes — same
//     finding as openaiScriptService's script expansion). Silent beats get "" — the worker
//     then skips the qwen TTS stage and sends Mini no reference_audios.
//   - delivery: per-beat performance direction (2026-07-25 — the static per-character
//     default_voice_direction gave every beat the same flat read; delivery now reacts to the
//     beat and feeds BOTH the qwen style_instruction and the Mini clip prompt).
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
  /** Per-beat performance direction from the LLM (emotion, pace, energy — e.g.
   *  "exasperated, rapid-fire, building to disbelief"). Feeds BOTH the qwen clone's
   *  style_instruction (appended to the character's base voice direction) and the Mini
   *  clip prompt. '' = fall back to the character's default_voice_direction. */
  delivery: string;
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

/** Exported for the model bake-off script — production callers go through expandVlogBeat. */
export function buildExpansionSystemPrompt(character: CharacterVlogConfig, durationSeconds: number): string {
  return `You are the director for a fictional character vlogger's one-shot vlog clip.
Persona: ${character.persona_prompt}
Framing (every clip starts from this): ${character.vlog_framing_prefix}

The user gives you ONE beat. You turn it into a director's brief for ONE continuous shot — no cuts, no scene changes, no time skips — plus the character's single spoken line and how they deliver it.

Rules:
- enhanced_prompt: open with the framing above, then describe the shot in concrete detail a camera operator could follow:
  * The setting: where the character is, what's behind them, lighting, time of day, two or three specific props that sell the scene.
  * The physical performance ACROSS the whole shot: posture, hand gestures, facial expressions, and how they shift as the line lands (e.g. starts measured, builds to animated disbelief).
  * Camera behavior: framing distance, subtle handheld drift, where the character looks.
  * The arc of the shot: what happens in the moment BEFORE they speak, and what they do AFTER the line ends — a held look, a gesture, a shake of the head. Never more talking after the line.
- Be EXACT and exhaustive: the video model renders literally what you describe and improvises whatever you leave vague — vague elements warp, morph, or vanish mid-shot. Anchor everything you introduce: give each prop, item of clothing, and background element a fixed appearance and a fixed position, and keep it present and unchanged for the entire shot (if he picks up a fork, that fork exists until you say he puts it down). Introduce only what the shot needs — every named thing is a thing that must stay consistent.
  A thin prompt collapses to a generic room and a frozen character; enrich generously. Stay strictly on the user's beat.
- Do NOT put the spoken words inside enhanced_prompt — the line travels separately. Describing HOW the words are delivered is performance and belongs here; the words themselves do not.
- spoken_line: verbatim first-person speech, in persona, no stage directions, no quoted-aside narration. This is a vlog, not a speech: conversational, contractions, a little rough, self-interruption welcome. Budget: ≤ ${wordBudgetFor(durationSeconds)} words (spoken at ~${WORDS_PER_SECOND} words/sec over ${durationSeconds}s, with pauses and gestures filling the rest of the shot).
- delivery: 5-10 words of performance direction for THIS line on THIS beat — emotion, pace, energy (e.g. "exasperated, rapid-fire, building to disbelief"). It must react to the beat, not restate the persona. Timbre is fixed elsewhere; describe only the acting.
- If the beat implies the character does NOT speak (silent reaction, visual gag, montage), spoken_line and delivery are "".
- Keep everything original: no real people, no copyrighted characters, no brand names.

Output ONLY a JSON object (no markdown fences):
{ "enhanced_prompt": "...", "spoken_line": "...", "delivery": "..." }`;
}

/** Strips the markdown fences Claude occasionally wraps around bare JSON (explainer idiom). */
function parseExpansion(raw: string): { enhancedPrompt: string; spokenLine: string; delivery: string } | null {
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
  // delivery is optional in the output — older-shaped responses just fall back to the
  // character's default_voice_direction downstream.
  const delivery = typeof parsed.delivery === 'string' ? parsed.delivery.trim() : '';
  if (!enhancedPrompt) return null;
  return { enhancedPrompt, spokenLine, delivery };
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
    systemPrompt: buildExpansionSystemPrompt(args.character, args.durationSeconds),
    prompt: `Beat: ${args.beat}${pinnedLine
      ? '\n\nThe user quoted their exact dialogue in the beat — it will be used VERBATIM as the spoken line. Write enhanced_prompt and delivery (for the quoted line); set spoken_line to "".'
      : ''}`,
    maxTokens: VLOG_EXPANSION_MAX_TOKENS,
    ...(EFFORTLESS_MODELS.has(config.vlogExpansionModel) ? {} : { effort: VLOG_EXPANSION_EFFORT }),
  });
  const parsed = parseExpansion(raw);
  if (!parsed) throw new Error('vlog expansion returned no usable JSON');

  if (pinnedLine) {
    return { enhancedPrompt: parsed.enhancedPrompt, spokenLine: pinnedLine, delivery: parsed.delivery, linePinnedByUser: true };
  }
  return {
    enhancedPrompt: parsed.enhancedPrompt,
    spokenLine: parsed.spokenLine ? enforceWordBudget(parsed.spokenLine, args.durationSeconds) : '',
    delivery: parsed.delivery,
    linePinnedByUser: false,
  };
}

/**
 * The exact Mini prompt for the clip — persisted verbatim on the take unit (user-visible on
 * the detail/regen screen, per the 7/24 regen-visibility lock). The spoken line rides as
 * quoted dialogue so Mini speaks it even without the audio pin; with the pin, the qwen clone
 * audio drives voice + lip-sync and this keeps the model on-script.
 *
 * The closing "no further speech" rule is the 2026-07-25 ad-lib fix: the pinned clone audio
 * usually runs shorter than the clip (the 10s smoke's WAV was 7.4s), and Mini with
 * generate_audio IMPROVISED nonsense dialogue into the uncovered tail. Silent beats get the
 * same guard in the other direction (no speech at all).
 */
export function buildClipPrompt(character: CharacterVlogConfig, expansion: VlogExpansion): string {
  if (!expansion.spokenLine) {
    return `${expansion.enhancedPrompt}
The character does not speak at any point — only natural ambient sound.`;
  }
  const delivery = expansion.delivery || character.default_voice_direction;
  return `${expansion.enhancedPrompt}
Speaking the following as spoken dialogue, ${delivery}: "${expansion.spokenLine}"
After the line ends the character stops talking — only natural ambient sound for the rest of the shot, no further speech.`;
}
