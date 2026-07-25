// SPIKE (throwaway) — fresh Voice A clone clip for the Wan arm-B retry: SHORT (3–5s, fits Wan's
// 5s slot) and teacher-realistic (slow/calm style_instruction — the lever proven in
// spikeLessonCodeSwitch, instead of reusing the 1.8×-pace test clip Andrew flagged as "a bit off").
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeVoiceATeacherClip.ts
// env: REPLICATE_API_TOKEN

import 'dotenv/config';
import Replicate from 'replicate';
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = `${process.env.HOME}/Downloads/spike-teacher-wanflash/voiceA-teacher-short.wav`;
const VOICE_A_CLIP = `${process.env.HOME}/Downloads/clipA_voice_isolated.mp3`;
const VOICE_A_TRANSCRIPT =
  "They stood no chance. Then Jack came up with an idea. In theory, as long as it was under attack, the crystal horn rabbit couldn't activate its escape skill. So Jack planned to act as bait to lure the crystal horn rabbit, while Mary looked for an opportunity to strike. After devising the plan, Mary used earth magic.";

const TEXT = 'Manzana means apple. Repeat after me: manzana. Very good.';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

function toUrl(o: unknown): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v && typeof (v as { url?: unknown }).url === 'function') return String((v as { url: () => unknown }).url());
  if (v && (v as { url?: unknown }).url) return String((v as { url: unknown }).url);
  throw new Error('qwen3-tts: no output url');
}

async function main(): Promise<void> {
  const output = await replicate.run('qwen/qwen3-tts', {
    input: {
      text: TEXT,
      mode: 'voice_clone',
      reference_audio: readFileSync(VOICE_A_CLIP),
      reference_text: VOICE_A_TRANSCRIPT,
      language: 'auto',
      style_instruction:
        'A warm, calm language teacher speaking slowly and clearly to a beginner, natural conversational pace, friendly smile in the voice.',
    },
  });
  const res = await fetch(toUrl(output));
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  writeFileSync(OUT, Buffer.from(await res.arrayBuffer()));
  console.log('✓', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
