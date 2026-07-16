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
const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 500;
const TEMPERATURE = 0.7;

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

async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  let response: Response;
  try {
    response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      }),
    });
  } catch (err) {
    console.error('[promptIntelligence] OpenAI API unreachable:', err);
    throw new PromptIntelligenceError('LLM unreachable');
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
