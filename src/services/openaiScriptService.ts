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

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const SCRIPT_EXPANSION_MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 400;
const TEMPERATURE = 0.7;

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
