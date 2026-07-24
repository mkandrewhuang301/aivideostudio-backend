// SPIKE (throwaway, deletable) — Language Lessons §4.3: can ONE qwen3-tts voice code-switch
// (native explanation + target phrase) cleanly? Tests the Teacher template's core TTS question.
//
// Clips (Spanish-for-English pair):
//   1. serena-mixed-auto   — Serena, ONE call, language=auto, mixed EN explanation + ES phrases
//   2. serena-split-en/es  — Serena, per-line language hints (the escape hatch): EN call + ES call
//   3. voiceA-mixed-auto   — Voice A CLONE (GenAm male), same mixed text — does the clone carry an
//                            English accent into the Spanish?
//   4. serena-slow-es      — Serena, ES + style_instruction slow — the Cartoon slow-rate lever
//                            (qwen has no numeric rate param; instruction is the only lever)
//
// Judge BY EAR: (a) does mixed-auto butcher the Spanish? (b) is split noticeably cleaner?
// (c) does the clone's accent survive? (d) does style_instruction actually slow delivery?
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeLessonCodeSwitch.ts
// env: REPLICATE_API_TOKEN

import 'dotenv/config';
import Replicate from 'replicate';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = `${process.env.HOME}/Downloads/spike-lesson-codeswitch`;
const VOICE_A_CLIP = `${process.env.HOME}/Downloads/clipA_voice_isolated.mp3`;
const VOICE_A_TRANSCRIPT =
  "They stood no chance. Then Jack came up with an idea. In theory, as long as it was under attack, the crystal horn rabbit couldn't activate its escape skill. So Jack planned to act as bait to lure the crystal horn rabbit, while Mary looked for an opportunity to strike. After devising the plan, Mary used earth magic.";

const MIXED_TEXT =
  'In Spanish, to order politely, you say: Me gustaría un café, por favor. Listen again: Me gustaría un café, por favor. Now you try!';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

interface Clip {
  name: string;
  input: Record<string, unknown>;
}

const CLIPS: Clip[] = [
  {
    name: '1-serena-mixed-auto',
    input: { text: MIXED_TEXT, mode: 'custom_voice', speaker: 'Serena', language: 'auto' },
  },
  {
    name: '2a-serena-split-en',
    input: {
      text: 'In Spanish, to order politely, you say:',
      mode: 'custom_voice', speaker: 'Serena', language: 'English',
    },
  },
  {
    name: '2b-serena-split-es',
    input: {
      text: 'Me gustaría un café, por favor.',
      mode: 'custom_voice', speaker: 'Serena', language: 'Spanish',
    },
  },
  {
    name: '3-voiceA-mixed-auto',
    input: {
      text: MIXED_TEXT,
      mode: 'voice_clone',
      reference_audio: readFileSync(VOICE_A_CLIP),
      reference_text: VOICE_A_TRANSCRIPT,
      language: 'auto',
    },
  },
  {
    name: '4-serena-slow-es',
    input: {
      text: 'Me gustaría un café, por favor.',
      mode: 'custom_voice', speaker: 'Serena', language: 'Spanish',
      style_instruction: 'Speak very slowly and clearly, one word at a time, as if teaching a complete beginner.',
    },
  },
];

function toUrl(o: unknown): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v && typeof (v as { url?: unknown }).url === 'function') return String((v as { url: () => unknown }).url());
  if (v && (v as { url?: unknown }).url) return String((v as { url: unknown }).url);
  throw new Error('qwen3-tts: no output url');
}

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  for (const clip of CLIPS) {
    const t0 = Date.now();
    try {
      const output = await replicate.run('qwen/qwen3-tts', { input: clip.input });
      const url = toUrl(output);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(`${OUT}/${clip.name}.wav`, buf);
      console.log(`✓ ${clip.name}.wav  ${(buf.length / 1024).toFixed(0)}KB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.log(`✗ ${clip.name} FAILED: ${String((e as Error)?.message ?? e)}`);
    }
  }
  console.log(`\nDone — listen in ${OUT}`);
}

void run();
