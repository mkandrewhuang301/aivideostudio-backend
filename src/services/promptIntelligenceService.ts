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
  'brackets (e.g. [my dog]) exactly as written. One paragraph. Output only the improved prompt, ' +
  'no preamble or explanation.';

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

/** Reference video present → the generation continues an existing clip. The structured
 *  continuity directive is the whole point: seamless resume, no cut, preserve everything. */
export const DISPATCH_CONTINUATION_INSTRUCTION =
  'You rewrite prompts for an AI video generation model. The user is continuing an existing ' +
  'video referenced by [videoN] tokens. Rewrite the request into a prompt that continues the ' +
  'referenced video directly from its final moment: NO cut, NO transition, NO new establishing ' +
  'shot — the action resumes seamlessly. Explicitly preserve the subject\'s identity and ' +
  'position, direction and speed of motion, camera direction and movement, lighting, and audio ' +
  'ambience from the referenced video, then describe the new action. Keep every [token] exactly ' +
  'as written. One paragraph. Output only the rewritten prompt, no preamble.';

/** Reference image(s) only → image-to-video: hold the still's content, write the motion. */
export const DISPATCH_I2V_INSTRUCTION =
  'You rewrite prompts for an AI video generation model. The user supplied reference image(s) ' +
  '([imageN] tokens) to animate. Rewrite the request into an image-to-video prompt: keep the ' +
  'reference image content exactly as-is (subject, composition, style, lighting) and describe ' +
  'the motion that fulfills the request — subject action, camera movement, ambient/background ' +
  'motion. Keep every [token] exactly as written. One paragraph. Output only the rewritten ' +
  'prompt, no preamble.';

/**
 * Rewrites a freeform video prompt for provider dispatch. Shape-aware: continuation when a
 * reference video is present, i2v when only reference images, plain cinematic rewrite otherwise
 * (the shared DEFAULT_ENHANCE_PROMPT_INSTRUCTION). NEVER throws — returns null on any failure.
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
    : DEFAULT_ENHANCE_PROMPT_INSTRUCTION;
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
