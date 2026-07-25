// Character-vlog planner (gorilla multi-take, 2026-07-24 spec:
// ~/.planning/notes/2026-07-24-gorilla-multitake-planner-spec.md §4).
//
// Sonnet-5 plans the WHOLE vlog in one call: the backend deterministically allocates take count
// + per-take seconds (never the LLM's choice), then the planner owns script AND setting per take
// inside those constraints. Variety is enforced through the setting_tag/framing_tag ledger —
// pairwise-distinct across takes — which doubles as the regen input (a replacement take must not
// reuse its siblings' tags).
//
// FAIL-CLOSED (unlike the explainers' structural fallback): a vlog with a broken plan is worth
// less than the refund. One repair pass, then throw — the worker's catch marks failed + refunds.

import type { CharacterVlogConfig } from '../config/characters';
import { generateClaudeText } from './providers/ReplicateProvider';

// Same model + reasoning effort as the explainer script stage (openaiScriptService.ts) —
// take allocation/variety is a reasoning job, not a mechanical one (Andrew lock 2026-07-24).
const VLOG_PLANNER_MODEL = 'anthropic/claude-sonnet-5';
const VLOG_PLANNER_MAX_TOKENS = 4096;

/** Spoken-words pacing budget — extends the 7/23 per-clip discipline to multi-take totals. */
const WORDS_PER_SECOND = 2.5;
/** Spoken lines may overshoot the per-take budget by this much before validation complains. */
const WORD_BUDGET_TOLERANCE = 1.15;

/** Mini's duration window (resolveDurationSeconds clamps 4..15 for this model family). */
const MIN_TAKE_SECONDS = 4;
const MAX_TAKE_SECONDS = 15;
const TARGET_TAKE_SECONDS = 10;

/**
 * Framing menu for the variety ledger. Must stay ≥ the max take count (6) so pairwise-distinct
 * is always satisfiable.
 */
const FRAMING_TAGS = [
  'selfie-closeup',
  'walk-and-talk',
  'over-shoulder',
  'prop-demo',
  'reaction-cam',
  'wide-establishing',
] as const;

export interface PlannedTake {
  take_index: number;
  duration_seconds: number;
  setting: string;
  setting_tag: string;
  framing_tag: string;
  visual_direction: string;
  spoken_line: string;
  voice_direction: string;
}

/**
 * Deterministic take allocation (spec §4.2): N = clamp(round(total/10), 2, 6) — 15→2, 30→3,
 * 45→5, 60→6 — seconds distributed evenly, earliest takes absorb the remainder, every take
 * inside Mini's [4, 15] window. The picker values (15/30/45/60) always land in-band; the ceil
 * guard keeps arbitrary totals honest.
 */
export function allocateTakes(totalSeconds: number): number[] {
  let count = Math.min(6, Math.max(2, Math.round(totalSeconds / TARGET_TAKE_SECONDS)));
  count = Math.max(count, Math.ceil(totalSeconds / MAX_TAKE_SECONDS));
  const base = Math.floor(totalSeconds / count);
  let remainder = totalSeconds - base * count;
  return Array.from({ length: count }, () => {
    const seconds = Math.min(MAX_TAKE_SECONDS, Math.max(MIN_TAKE_SECONDS, base + (remainder > 0 ? 1 : 0)));
    if (remainder > 0) remainder -= 1;
    return seconds;
  });
}

function wordBudgetFor(seconds: number): number {
  return Math.floor(WORDS_PER_SECOND * seconds);
}

function countWords(line: string): number {
  return line.trim() ? line.trim().split(/\s+/).length : 0;
}

function buildSystemPrompt(character: CharacterVlogConfig): string {
  return `You are the showrunner for a fictional character vlogger.
Persona: ${character.persona_prompt}
The user gives you a topic (and optional vibe). You decide BOTH what the character says AND where they are, per take.

You will be told the EXACT take count and each take's duration in seconds — these are fixed, never change them.

Rules:
- spoken_line is verbatim first-person speech, in persona, no stage directions, no quoted-aside narration.
- Each spoken_line must fit its word budget (given per take) — it will be spoken aloud at ~${WORDS_PER_SECOND} words/sec.
- Every take needs a framing_tag from this menu: ${FRAMING_TAGS.join(', ')} — all takes pairwise-DISTINCT.
- Every take needs a short setting_tag slug (e.g. "home-office", "jungle-gym") — all takes pairwise-DISTINCT.
- setting is a concrete visual location description for the video model; visual_direction is the camera/action direction.
- Take 1 hooks the topic in its first sentence; the last take lands a sign-off.
- No take may open with the same word or phrase as another take.
- Jump-cut grammar: the takes are consecutive beats of ONE monologue, not separate vlogs.
- voice_direction is a short delivery note (pace/energy), consistent with the character across takes.

Output ONLY a JSON object (no markdown fences) in this exact shape:
{ "takes": [ { "take_index": 0, "duration_seconds": 10, "setting": "...", "setting_tag": "...",
"framing_tag": "...", "visual_direction": "...", "spoken_line": "...", "voice_direction": "..." } ] }`;
}

function buildUserPrompt(args: {
  topic: string;
  vibe?: string;
  takeSeconds: number[];
}): string {
  const lines = args.takeSeconds.map(
    (seconds, index) => `take ${index}: ${seconds}s, spoken_line ≤ ${wordBudgetFor(seconds)} words`,
  );
  return `Topic: ${args.topic}${args.vibe ? `\nVibe: ${args.vibe}` : ''}

Plan EXACTLY ${args.takeSeconds.length} takes:
${lines.join('\n')}`;
}

/** Returns a list of contract violations (empty = valid). Durations are coerced to the
 *  backend allocation beforehand — allocation is never the planner's to change. */
function validateTakes(takes: PlannedTake[], takeSeconds: number[]): string[] {
  const problems: string[] = [];
  if (takes.length !== takeSeconds.length) {
    problems.push(`expected ${takeSeconds.length} takes, got ${takes.length}`);
    return problems; // per-take checks are meaningless on a count mismatch
  }
  const settingTags = new Set<string>();
  const framingTags = new Set<string>();
  takes.forEach((take, index) => {
    if (!take.spoken_line?.trim()) {
      problems.push(`take ${index}: spoken_line is empty`);
    } else {
      const ceiling = Math.ceil(wordBudgetFor(takeSeconds[index]!) * WORD_BUDGET_TOLERANCE);
      const words = countWords(take.spoken_line);
      if (words > ceiling) {
        problems.push(`take ${index}: spoken_line is ${words} words, budget ceiling is ${ceiling}`);
      }
    }
    if (!take.setting?.trim()) problems.push(`take ${index}: setting is empty`);
    if (!take.visual_direction?.trim()) problems.push(`take ${index}: visual_direction is empty`);
    if (!take.setting_tag?.trim()) {
      problems.push(`take ${index}: setting_tag is empty`);
    } else if (settingTags.has(take.setting_tag)) {
      problems.push(`take ${index}: setting_tag "${take.setting_tag}" repeats an earlier take`);
    }
    if (!(FRAMING_TAGS as readonly string[]).includes(take.framing_tag)) {
      problems.push(`take ${index}: framing_tag "${take.framing_tag}" is not in the menu`);
    } else if (framingTags.has(take.framing_tag)) {
      problems.push(`take ${index}: framing_tag "${take.framing_tag}" repeats an earlier take`);
    }
    if (take.setting_tag) settingTags.add(take.setting_tag);
    if (take.framing_tag) framingTags.add(take.framing_tag);
  });
  return problems;
}

/** Replicate exposes no structured-output param, so the JSON contract is prompt discipline;
 *  strip the markdown fences Claude occasionally wraps around bare JSON before validating
 *  (same idiom as expandExplainerScript). */
function parsePlannerOutput(raw: string, takeSeconds: number[]): PlannedTake[] | null {
  const content = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  if (!content) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.takes)) return null;
  const takes: PlannedTake[] = [];
  for (const [index, candidate] of parsed.takes.entries()) {
    const c = candidate as Record<string, unknown>;
    if (typeof c !== 'object' || c === null) return null;
    takes.push({
      take_index: index,
      // Allocation is backend-owned — coerce whatever the model wrote.
      duration_seconds: takeSeconds[index] ?? 0,
      setting: typeof c.setting === 'string' ? c.setting.trim() : '',
      setting_tag: typeof c.setting_tag === 'string' ? c.setting_tag.trim() : '',
      framing_tag: typeof c.framing_tag === 'string' ? c.framing_tag.trim() : '',
      visual_direction: typeof c.visual_direction === 'string' ? c.visual_direction.trim() : '',
      spoken_line: typeof c.spoken_line === 'string' ? c.spoken_line.trim() : '',
      voice_direction: typeof c.voice_direction === 'string' ? c.voice_direction.trim() : '',
    });
  }
  return takes;
}

/**
 * Plans a full vlog: one Sonnet-5 call, validate against the contract, ONE repair pass naming
 * the violations, then throw (worker refunds). Returns takes with backend-allocated durations.
 */
export async function planVlogTakes(args: {
  character: CharacterVlogConfig;
  topic: string;
  vibe?: string;
  takeSeconds: number[];
}): Promise<PlannedTake[]> {
  const systemPrompt = buildSystemPrompt(args.character);
  const userPrompt = buildUserPrompt(args);

  const firstRaw = await generateClaudeText(VLOG_PLANNER_MODEL, {
    systemPrompt,
    prompt: userPrompt,
    maxTokens: VLOG_PLANNER_MAX_TOKENS,
    effort: 'medium',
  });
  const first = parsePlannerOutput(firstRaw, args.takeSeconds);
  const firstProblems = first ? validateTakes(first, args.takeSeconds) : ['output was not valid JSON with a takes array'];
  if (first && firstProblems.length === 0) return first;

  // One repair pass: the model sees its own broken plan and the exact violations.
  console.warn(`[vlog-planner] first plan failed validation (${firstProblems.join('; ')}); requesting repair`);
  const repairRaw = await generateClaudeText(VLOG_PLANNER_MODEL, {
    systemPrompt,
    prompt: `${userPrompt}

Your previous plan had these problems:
${firstProblems.map((problem) => `- ${problem}`).join('\n')}

Previous plan:
${first ? JSON.stringify({ takes: first }, null, 2) : firstRaw.slice(0, 4000)}

Return the corrected plan ONLY, same JSON shape.`,
    maxTokens: VLOG_PLANNER_MAX_TOKENS,
    effort: 'medium',
  });
  const repaired = parsePlannerOutput(repairRaw, args.takeSeconds);
  const repairedProblems = repaired
    ? validateTakes(repaired, args.takeSeconds)
    : ['repair output was not valid JSON with a takes array'];
  if (!repaired || repairedProblems.length > 0) {
    throw new Error(`vlog planner failed validation after repair: ${repairedProblems.join('; ')}`);
  }
  return repaired;
}

/** The exact Mini prompt for a take — persisted verbatim on the take unit (user-visible). */
export function buildTakePrompt(character: CharacterVlogConfig, take: PlannedTake): string {
  const voiceDirection = take.voice_direction || character.default_voice_direction;
  return `${character.vlog_framing_prefix}
Setting: ${take.setting}.
Action: ${take.visual_direction}.
Speaking the following as spoken dialogue, ${voiceDirection}: "${take.spoken_line}"`;
}
