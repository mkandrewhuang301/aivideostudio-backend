// Generates the short, bundled narrator auditions used by VideoExplainerFormatSheet.
// These use the same fal-hosted Gemini TTS model and voice ids as production narration.
//
// Run from aivideostudio-backend:
//   npx tsx src/scripts/generateVideoExplainerVoicePreviews.ts

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODEL = 'gemini-3.1-flash-tts-preview';
const SAMPLE_TEXT = 'The door opened, and in that moment, everything changed.';
const VOICES = ['Kore', 'Zephyr', 'Aoede', 'Puck', 'Charon', 'Orus'] as const;
const OUTPUT_DIR = path.resolve(
  process.cwd(),
  '../aivideostudio-ios/Fantasia/Resources/VoicePreviews',
);

function findAudio(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const record = node as Record<string, unknown>;
  const mimeType = typeof record.mime_type === 'string' ? record.mime_type : '';
  if ((record.type === 'audio' || mimeType.startsWith('audio')) && typeof record.data === 'string') {
    return record.data;
  }
  for (const value of Object.values(record)) {
    const audio = findAudio(value);
    if (audio) return audio;
  }
  return null;
}

function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');

  for (const voice of VOICES) {
    const response = await fetch(INTERACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: MODEL,
        input: SAMPLE_TEXT,
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice }] },
      }),
    });
    if (!response.ok) throw new Error(`${voice} preview failed (${response.status})`);

    const encodedAudio = findAudio(await response.json());
    if (!encodedAudio) throw new Error(`${voice} preview returned no audio`);

    const outputPath = path.join(OUTPUT_DIR, `video-explainer-${voice.toLowerCase()}.wav`);
    await writeFile(outputPath, pcmToWav(Buffer.from(encodedAudio, 'base64')));
    console.log(`Generated ${path.basename(outputPath)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
