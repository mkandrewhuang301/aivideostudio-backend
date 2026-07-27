// src/services/promptIntelligenceService.ts
// LLM prompt-intelligence helpers behind POST /api/prompt (routes/prompt.ts):
//   enhancePrompt()   — rough user prompt → improved video prompt OR expanded short script
//   promptFromImage() — finished image (presigned R2 URL) → prompt tailored to that image
//
// Both accept an optional per-preset `instruction` override (PresetDef.prompt_intelligence,
// SERVER-ONLY) so any preset can reshape the behavior — script generation, cinematic spice-up,
// i2v motion prompts — without new code.
//
// Unlike openaiScriptService.expandScript (fail-open: a template fallback is always dispatchable),
// these FAIL LOUD with PromptIntelligenceError: they back an explicit suggest action, and silently
// echoing the user's input back would just look broken. The route maps the error to a 502.

import { config } from '../config';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
// gpt-5 family is a reasoning model: max_completion_tokens (not max_tokens), no temperature,
// reasoning_effort instead. 'low' — a little thought helps the creative rewrite; 'minimal'
// produces flatter prompts. The token cap must cover reasoning tokens + the visible output.
const MODEL = 'gpt-5-mini';
const MAX_COMPLETION_TOKENS = 800;
const REASONING_EFFORT = 'low';

export class PromptIntelligenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptIntelligenceError';
  }
}

export type EnhanceMode = 'prompt' | 'script';

export const DEFAULT_ENHANCE_PROMPT_INSTRUCTION =
  'You improve rough prompts for an AI video generation model. Rewrite the user\'s prompt into ' +
  'a vivid, production-ready video prompt: concrete subject and action, setting, camera framing ' +
  'and movement, lighting, and mood. Keep the user\'s core idea and any names/tokens in square ' +
  'brackets (e.g. [my dog]) exactly as written — and NEVER introduce new square-bracket tokens ' +
  'the user did not write. One paragraph. Output only the improved prompt, no preamble or ' +
  'explanation.';

export const DEFAULT_ENHANCE_SCRIPT_INSTRUCTION =
  'You turn a rough idea into a short, shootable video script for an AI video generation model. ' +
  'Expand the user\'s idea into natural spoken dialogue or narration lines plus brief staging/' +
  'framing description (shots, setting, energy). Keep it concise, concrete, and shootable in ' +
  'under a minute. Output only the script text, no preamble or explanation.';

export const DEFAULT_FROM_IMAGE_INSTRUCTION =
  'You write image-to-video animation prompts. Look at the provided image and write a prompt ' +
  'that animates it faithfully: describe the actual subject, composition, and lighting you see, ' +
  'then the motion that suits them — camera movement, subject action, ambient/background motion. ' +
  'Stay true to the image\'s style and mood; do not invent content that is not in the frame. ' +
  'One paragraph. Output only the prompt text, no preamble or explanation.';

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface ChatMessage {
  role: 'system' | 'user';
  content: string | ChatContentPart[];
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface ChatCallOptions {
  model?: string;
  maxCompletionTokens?: number;
  reasoningEffort?: string;
  /** Wall-clock cap via AbortController — the in-pipeline interceptor needs a bounded fail-open. */
  timeoutMs?: number;
}

async function chatCompletion(messages: ChatMessage[], opts: ChatCallOptions = {}): Promise<string> {
  const controller = opts.timeoutMs !== undefined ? new AbortController() : undefined;
  const timer = opts.timeoutMs !== undefined && controller
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : undefined;
  let response: Response;
  try {
    response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model ?? MODEL,
        messages,
        max_completion_tokens: opts.maxCompletionTokens ?? MAX_COMPLETION_TOKENS,
        reasoning_effort: opts.reasoningEffort ?? REASONING_EFFORT,
      }),
      signal: controller?.signal,
    });
  } catch (err) {
    console.error('[promptIntelligence] OpenAI API unreachable:', err);
    throw new PromptIntelligenceError('LLM unreachable');
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    console.error(`[promptIntelligence] OpenAI chat completion error: ${response.status}`);
    throw new PromptIntelligenceError(`LLM returned ${response.status}`);
  }

  const json = (await response.json()) as OpenAIChatCompletionResponse;
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new PromptIntelligenceError('LLM returned empty completion');
  }
  return content;
}

/**
 * Improves a rough user prompt. `mode` picks the generic default instruction ('prompt' =
 * cinematic improvement, 'script' = expand into a short script); a per-preset `instruction`
 * overrides both. Throws PromptIntelligenceError on any LLM failure.
 */
export async function enhancePrompt(args: {
  prompt: string;
  mode?: EnhanceMode;
  instruction?: string;
}): Promise<string> {
  const system =
    args.instruction ??
    (args.mode === 'script' ? DEFAULT_ENHANCE_SCRIPT_INSTRUCTION : DEFAULT_ENHANCE_PROMPT_INSTRUCTION);
  return chatCompletion([
    { role: 'system', content: system },
    { role: 'user', content: args.prompt },
  ]);
}

/**
 * Writes a prompt tailored to a finished image (vision call). `imageUrl` must be a
 * server-generated presigned R2 URL — routes/prompt.ts resolves generation_id/upload_id itself
 * and never accepts client-supplied URLs (SSRF). Optional `hint` is the user's steer ("make it
 * rainy") and MUST be moderated by the caller before it gets here.
 * Throws PromptIntelligenceError on any LLM failure.
 */
export async function promptFromImage(args: {
  imageUrl: string;
  instruction?: string;
  hint?: string;
}): Promise<string> {
  const userParts: ChatContentPart[] = [
    {
      type: 'text',
      text: args.hint
        ? `Write the prompt for this image. User direction: ${args.hint}`
        : 'Write the prompt for this image.',
    },
    { type: 'image_url', image_url: { url: args.imageUrl } },
  ];
  return chatCompletion([
    { role: 'system', content: args.instruction ?? DEFAULT_FROM_IMAGE_INSTRUCTION },
    { role: 'user', content: userParts },
  ]);
}

// ─── In-pipeline dispatch interceptor (2026-07-25) ──────────────────────────────
// enhanceForDispatch backs the POST /api/generations interceptor: it rewrites the user's raw
// prompt into the prompt the video provider actually receives. Unlike the suggest endpoints
// above (explicit user action, fail-loud 502), this FAILS OPEN — a slow/down LLM must never
// block a paid dispatch, so any error/timeout/empty completion returns null and the route
// dispatches the raw prompt. gpt-5-mini at 'minimal' effort: 2026-07-25 live A/B vs 'low' on
// the continuation instruction came out equal in quality at the same ~5s latency ('low' stays
// on the suggest endpoints where the extra polish is worth it).

const INTERCEPTOR_MODEL = 'gpt-5-mini';
const INTERCEPTOR_MAX_COMPLETION_TOKENS = 800;
const INTERCEPTOR_REASONING_EFFORT = 'minimal';
const INTERCEPTOR_TIMEOUT_MS = 10_000;

/** Reference video present → the request involves an existing clip. 2026-07-27 FLIP (Andrew):
 *  no seam directive either way — the old "NO cut, resume seamlessly" rule pushed Seedance Mini
 *  into frame-continuations that glitch visibly at the seam, and converting the pill's
 *  next-shot suggestions back to seamless defeated the guide. The interceptor is now a pure
 *  intent-enricher: keep the user's meaning exactly (continuation, next shot, or anything
 *  else), just make it concrete and descriptive. */
export const DISPATCH_CONTINUATION_INSTRUCTION =
  'You rewrite prompts for an AI video generation model. The user\'s request references an ' +
  'existing video via [videoN] tokens. Rewrite the request into a clearer, more descriptive ' +
  'prompt that faithfully realizes the user\'s intent — keep their meaning exactly and only ' +
  'make it concrete: subject action, camera movement, lighting and mood, ambience. Follow the ' +
  'user\'s lead on how the referenced video is used (seamless continuation, next shot, source ' +
  'material) — never impose one and never reverse their choice. You CANNOT see the referenced ' +
  'video, so never invent specifics of its content. Every concrete detail the user themselves ' +
  'wrote (subject appearance, clothing, setting, props, mood) is a continuity anchor — carry ' +
  'it through the rewrite, never compress it into generic references like "the same subject". ' +
  'But where the user gave no detail of their own, a generic reference ("the subject", "the ' +
  'setting") is the honest choice — never fill the gap with invented specifics. Keep every ' +
  '[token] exactly as written, and never introduce new square-bracket tokens. One paragraph. ' +
  'Output only the rewritten prompt, no preamble.';

/** Reference image(s) only → image-to-video: hold the still's content, write the motion. */
export const DISPATCH_I2V_INSTRUCTION =
  'You rewrite prompts for an AI video generation model. The user supplied reference image(s) ' +
  '([imageN] tokens) to animate. Rewrite the request into an image-to-video prompt: keep the ' +
  'reference image content exactly as-is (subject, composition, style, lighting) and describe ' +
  'the motion that fulfills the request — subject action, camera movement, ambient/background ' +
  'motion. Keep every [token] exactly as written, and never introduce new square-bracket ' +
  'tokens. One paragraph. Output only the rewritten prompt, no preamble.';

/** Plain freeform t2v (no refs) → SELF-GATING polish (2026-07-27 spike, Andrew): an
 *  already-detailed prompt is returned VERBATIM — the interceptor can only mess those up,
 *  not improve them — and only thin/rough prompts get the full cinematic rewrite. Distinct
 *  from the suggester's DEFAULT_ENHANCE_PROMPT_INSTRUCTION on purpose: the enhance BUTTON
 *  must always return something visibly better (verbatim would look broken), the silent
 *  interceptor must do no harm. Side benefit: gate judgment on detailed prompts often
 *  outruns the 10s timeout → fail-open raw dispatch, which IS the desired outcome there. */
export const DISPATCH_FREEFORM_INSTRUCTION =
  'You improve rough prompts for an AI video generation model. First judge what the user ' +
  'wrote. If it is already a detailed, production-ready video prompt — concrete subject and ' +
  'action, setting, and some sense of camera, lighting, or style — your default is to change ' +
  'NOTHING: output the user\'s text verbatim. Only edit to fix a genuine defect (a ' +
  'contradiction, grammar that confuses the model). Never add camera moves, lighting ' +
  'descriptors, technical specs, or mood words the user did not write. When the prompt is ' +
  'thin or rough, rewrite it into a vivid, production-ready video prompt: concrete subject ' +
  'and action, setting, camera framing and movement, lighting, and mood. Either way: keep ' +
  'the user\'s core idea and any names/tokens in square brackets (e.g. [my dog]) exactly as ' +
  'written — and NEVER introduce new square-bracket tokens the user did not write. One ' +
  'paragraph. Output only the final prompt, no preamble or explanation.';

/**
 * Rewrites a freeform video prompt for provider dispatch. Shape-aware: continuation when a
 * reference video is present, i2v when only reference images, self-gating polish otherwise
 * (DISPATCH_FREEFORM_INSTRUCTION — detailed prompts pass through verbatim). NEVER throws —
 * returns null on any failure.
 */
export async function enhanceForDispatch(args: {
  prompt: string;
  hasReferenceVideos: boolean;
  hasReferenceImages: boolean;
}): Promise<string | null> {
  const instruction = args.hasReferenceVideos
    ? DISPATCH_CONTINUATION_INSTRUCTION
    : args.hasReferenceImages
    ? DISPATCH_I2V_INSTRUCTION
    : DISPATCH_FREEFORM_INSTRUCTION;
  try {
    return await chatCompletion(
      [
        { role: 'system', content: instruction },
        { role: 'user', content: args.prompt },
      ],
      {
        model: INTERCEPTOR_MODEL,
        maxCompletionTokens: INTERCEPTOR_MAX_COMPLETION_TOKENS,
        reasoningEffort: INTERCEPTOR_REASONING_EFFORT,
        timeoutMs: INTERCEPTOR_TIMEOUT_MS,
      },
    );
  } catch (err) {
    console.warn(
      '[promptIntelligence] dispatch enhancement failed, falling back to raw prompt:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
