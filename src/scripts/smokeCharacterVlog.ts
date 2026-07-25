// Smoke: character-vlog v1 ONE-SHOT pipeline WITHOUT the API/queue/DB — exercises the real
// expansion pass + qwen voice clone + runVlogTake directly (the worker's exact stages), so a
// live end-to-end costs one clip and needs no deploy.
//
//   npx tsx src/scripts/smokeCharacterVlog.ts --upload-assets
//   npx tsx src/scripts/smokeCharacterVlog.ts --go --beat "gorilla rants about airline food" [--duration 10] [--no-voice]
//
// Assets: Andrew's gorilla selfie (Downloads/Untitled.png) + harvard-14s.wav (trimmed from
// harvard.wav — reference_audios cap is 15s TOTAL per the live schema, O-2 resolved 7/25).
// Output: ~/Downloads/smoke-vlog/oneshot.mp4 + the expansion JSON printed for review.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2, R2_BUCKET } from '../storage/r2';
import { uploadBufferToR2 } from '../services/archivalService';
import { replicateQwenTts, runVlogTake } from '../services/providers/ReplicateProvider';
import { buildClipPrompt, expandVlogBeat } from '../services/vlogExpansionService';
import { SERVER_CHARACTERS, type CharacterVlogConfig } from '../config/characters';

const SHEET_LOCAL = `${process.env.HOME}/Downloads/Untitled.png`;
const AUDIO_LOCAL = `${process.env.HOME}/Downloads/harvard-14s.wav`;
const SHEET_KEY = 'assets/characters/gorilla/sheet-smoke.png';
const AUDIO_KEY = 'assets/characters/gorilla/voice-smoke-harvard.wav';
const OUT_DIR = `${process.env.HOME}/Downloads/smoke-vlog`;

function gorillaConfig(): CharacterVlogConfig {
  const gorilla = SERVER_CHARACTERS.find((c) => c.character_id === 'gorilla');
  if (!gorilla?.vlog) throw new Error('gorilla vlog block missing from characters.ts');
  return gorilla.vlog;
}

async function presign(key: string): Promise<string> {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 21600 });
}

async function uploadAssets(): Promise<void> {
  await uploadBufferToR2(readFileSync(SHEET_LOCAL), SHEET_KEY, 'image/png');
  await uploadBufferToR2(readFileSync(AUDIO_LOCAL), AUDIO_KEY, 'audio/wav');
  console.log(`uploaded:\n  ${SHEET_KEY}\n  ${AUDIO_KEY}`);
}

async function go(beat: string, durationSeconds: number, withVoice: boolean): Promise<void> {
  const config = gorillaConfig();
  execSync(`mkdir -p ${OUT_DIR}`);
  const stamp = Date.now();

  console.log(`\nexpanding beat (${durationSeconds}s)…`);
  const expansion = await expandVlogBeat({ character: config, beat, durationSeconds });
  const resolvedPrompt = buildClipPrompt(config, expansion);
  console.log('\n=== EXPANSION ===');
  console.log(`spoken_line (${expansion.linePinnedByUser ? 'user-pinned verbatim' : 'LLM-written'}): "${expansion.spokenLine}"`);
  console.log(`delivery: "${expansion.delivery || '(none — base voice direction only)'}"`);
  console.log(`resolved_prompt:\n${resolvedPrompt}`);

  // Voice stage (mirrors the worker): per-beat qwen clone → R2 → presigned reference_audios.
  let voiceUrl: string | undefined;
  if (withVoice && expansion.spokenLine && config.voice_reference_r2_key) {
    console.log('\ncloning spoken line (qwen voice_clone)…');
    const wav = await replicateQwenTts({
      text: expansion.spokenLine,
      mode: 'voice_clone',
      referenceAudioUrl: await presign(config.voice_reference_r2_key),
      referenceText: config.voice_reference_text,
      // Mirrors the worker: base timbre + per-beat acting direction.
      styleInstruction: expansion.delivery
        ? `${config.default_voice_direction}; ${expansion.delivery}`
        : config.default_voice_direction,
    });
    const voiceKey = `smoke-vlog/oneshot-voice-${stamp}.wav`;
    await uploadBufferToR2(wav, voiceKey, 'audio/wav');
    voiceUrl = await presign(voiceKey);
    console.log(`  archived ${voiceKey} (${wav.length} bytes)`);
  } else {
    console.log('\nvoice stage skipped (silent beat or --no-voice) — Mini rolls its own voice');
  }

  console.log(`\nfilming (${durationSeconds}s, sheet ref${voiceUrl ? ' + voice pin' : ''})…`);
  const clipKey = await runVlogTake(
    {
      prompt: resolvedPrompt,
      durationSeconds,
      referenceImages: [await presign(SHEET_KEY)],
      referenceAudios: voiceUrl ? [voiceUrl] : undefined,
    },
    `smoke-vlog/oneshot-${stamp}.mp4`,
  );
  const local = `${OUT_DIR}/oneshot.mp4`;
  execSync(`curl -sS -o ${local} "${await presign(clipKey)}"`);
  console.log(`\n=== DONE ===\narchived ${clipKey}\n${local}`);
}

async function main(): Promise<void> {
  const argv = process.argv;
  if (argv.includes('--upload-assets')) return uploadAssets();
  if (argv.includes('--go')) {
    const beatIdx = argv.indexOf('--beat');
    const beat = beatIdx >= 0 ? argv[beatIdx + 1] : undefined;
    if (!beat) throw new Error('--go requires --beat "..."');
    const durationIdx = argv.indexOf('--duration');
    const duration = durationIdx >= 0 ? Number(argv[durationIdx + 1]) : 10;
    return go(beat, duration, !argv.includes('--no-voice'));
  }
  console.log('usage: --upload-assets | --go --beat "..." [--duration 5|10|15] [--no-voice]');
}

main().catch((e) => { console.error('smoke failed:', e); process.exit(1); });
