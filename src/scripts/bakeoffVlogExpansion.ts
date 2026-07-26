// Bake-off: whose gorilla is funniest? Runs the PRODUCTION expansion system prompt
// (vlogExpansionService.buildExpansionSystemPrompt) through the three candidate models on
// three beats — dialogue, silent visual gag, user-quoted verbatim — and prints the raw JSON
// side by side. Costs ~2 cents total. Winner takes VLOG_EXPANSION_MODEL.
//
//   npx tsx src/scripts/bakeoffVlogExpansion.ts

import 'dotenv/config';
import { buildExpansionSystemPrompt, extractQuotedLine } from '../services/vlogExpansionService';
import { generateClaudeText } from '../services/providers/ReplicateProvider';
import { SERVER_CHARACTERS } from '../config/characters';

const DURATION = 10;
const BEATS = [
  'gorilla rants about airline food',
  'gorilla silently judges tourists taking selfies at the zoo',
  'gorilla finds out his vlog hit a million views, yelling "MAMA, I\'M FAMOUS!"',
];

const gorilla = SERVER_CHARACTERS.find((c) => c.character_id === 'gorilla')!.vlog!;
const systemPrompt = buildExpansionSystemPrompt(gorilla, DURATION);

function userPrompt(beat: string): string {
  const pinned = extractQuotedLine(beat);
  return `Beat: ${beat}${pinned
    ? '\n\nThe user quoted their exact dialogue in the beat — it will be used VERBATIM as the spoken line. Write only enhanced_prompt; set spoken_line to "".'
    : ''}`;
}

async function callClaude(beat: string): Promise<string> {
  return generateClaudeText('anthropic/claude-sonnet-5', {
    systemPrompt, prompt: userPrompt(beat), maxTokens: 1024, effort: 'low',
  });
}

async function callTerra(beat: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.6-terra',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt(beat) },
      ],
      max_completion_tokens: 1024,
    }),
  });
  if (!response.ok) throw new Error(`Terra ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() ?? '';
}

async function callFlash(beat: string): Promise<string> {
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt(beat) }] }],
        generationConfig: { maxOutputTokens: 1024, responseMimeType: 'application/json' },
      }),
    },
  );
  if (!response.ok) throw new Error(`Flash ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const json = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() ?? '';
}

const MODELS: Array<[string, (beat: string) => Promise<string>]> = [
  ['claude-sonnet-5/low', callClaude],
  ['gpt-5.6-terra', callTerra],
  ['gemini-3.6-flash', callFlash],
];

function words(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

async function main(): Promise<void> {
  for (const beat of BEATS) {
    console.log(`\n${'='.repeat(90)}\nBEAT: ${beat}\n${'='.repeat(90)}`);
    for (const [name, call] of MODELS) {
      const started = Date.now();
      try {
        const raw = await call(beat);
        const content = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
        const parsed = JSON.parse(content) as { enhanced_prompt?: string; spoken_line?: string };
        const line = parsed.spoken_line ?? '';
        console.log(`\n--- ${name} (${((Date.now() - started) / 1000).toFixed(1)}s, line ${words(line)} words)`);
        console.log(`LINE: "${line}"`);
        console.log(`PROMPT: ${parsed.enhanced_prompt}`);
      } catch (err) {
        console.log(`\n--- ${name} FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

main().catch((e) => { console.error('bakeoff failed:', e); process.exit(1); });
