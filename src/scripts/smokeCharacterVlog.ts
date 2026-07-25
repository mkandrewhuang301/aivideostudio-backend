// Smoke: character-vlog pipeline (gorilla multi-take) WITHOUT the API/queue/DB — exercises the
// real planner + runVlogTake + concat logic directly, with a human script-review gate between
// plan and film (the gate the worker intentionally doesn't have, spec §13).
//
//   npx tsx src/scripts/smokeCharacterVlog.ts --upload-assets
//   npx tsx src/scripts/smokeCharacterVlog.ts --plan --topic "..." [--vibe "..."]
//   npx tsx src/scripts/smokeCharacterVlog.ts --film
//
// Assets: Andrew's gorilla selfie (Downloads/Untitled.png) + harvard-14s.wav (trimmed from
// harvard.wav — reference_audios cap is 15s TOTAL per the live schema, O-2 resolved 7/25).
// 10s total → allocateTakes gives [5,5]; picker change to expose 10s is Andrew's later iOS edit.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2, R2_BUCKET } from '../storage/r2';
import { uploadBufferToR2 } from '../services/archivalService';
import { generateVlogStill, runVlogTake } from '../services/providers/ReplicateProvider';
import { SERVER_CHARACTERS, type CharacterVlogConfig } from '../config/characters';
import {
  allocateTakes,
  buildTakePrompt,
  planVlogTakes,
  type PlannedTake,
} from '../services/vlogPlannerService';

const SHEET_LOCAL = `${process.env.HOME}/Downloads/Untitled.png`;
const AUDIO_LOCAL = `${process.env.HOME}/Downloads/harvard-14s.wav`;
const SHEET_KEY = 'assets/characters/gorilla/sheet-smoke.png';
const AUDIO_KEY = 'assets/characters/gorilla/voice-smoke-harvard.wav';
const PLAN_FILE = `${process.env.HOME}/Downloads/smoke-vlog-plan.json`;
const STILLS_FILE = `${process.env.HOME}/Downloads/smoke-vlog-stills.json`;
const OUT_DIR = `${process.env.HOME}/Downloads/smoke-vlog`;

const TOTAL_SECONDS = 10; // programmatic — not a picker value yet (Andrew, 7/25)

function gorillaConfig(): CharacterVlogConfig {
  const gorilla = SERVER_CHARACTERS.find((c) => c.character_id === 'gorilla');
  if (!gorilla?.vlog) throw new Error('gorilla vlog block missing from characters.ts');
  return gorilla.vlog;
}

async function presign(key: string): Promise<string> {
  // 6h — long enough to survive plan-review-then-film across two script invocations.
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 21600 });
}

async function uploadAssets(): Promise<void> {
  await uploadBufferToR2(readFileSync(SHEET_LOCAL), SHEET_KEY, 'image/png');
  await uploadBufferToR2(readFileSync(AUDIO_LOCAL), AUDIO_KEY, 'audio/wav');
  console.log(`uploaded:\n  ${SHEET_KEY}\n  ${AUDIO_KEY}`);
}

interface SmokePlan {
  topic: string;
  vibe?: string;
  totalSeconds: number;
  takes: PlannedTake[];
}

/** Arm-B still prompt: the LLM brain's setting/action + framing, phrased as a FRAME (no speech,
 *  no motion — gpt-image renders one instant; Mini adds the rest from the take prompt). */
function buildStillPrompt(take: PlannedTake): string {
  return `Selfie-cam vlog still frame, handheld phone camera look: a gorilla vlogger filming themself.
Setting: ${take.setting}.
Composition/action: ${take.visual_direction}.
Framing style: ${take.framing_tag}.`;
}

async function downloadTo(url: string, local: string): Promise<void> {
  execSync(`curl -sS -o ${local} "${url}"`);
}

async function concatClips(localClips: string[], outName: string): Promise<void> {
  const listFile = `${OUT_DIR}/${outName}.txt`;
  writeFileSync(listFile, localClips.map((c) => `file '${c}'`).join('\n'));
  const final = `${OUT_DIR}/${outName}.mp4`;
  execSync(`ffmpeg -y -f concat -safe 0 -i ${listFile} -c copy ${final}`);
  console.log(`\n=== DONE ===\n${final}`);
}

/** Arm B step 1: render + review the per-take first frames (cheap gate before any Mini spend). */
async function stills(): Promise<void> {
  const smokePlan = JSON.parse(readFileSync(PLAN_FILE, 'utf8')) as SmokePlan;
  const sheetUrl = await presign(SHEET_KEY);
  execSync(`mkdir -p ${OUT_DIR}`);
  const stillKeys: string[] = [];
  for (const take of smokePlan.takes) {
    console.log(`rendering still for take ${take.take_index}…`);
    const key = await generateVlogStill(
      buildStillPrompt(take), sheetUrl, `smoke-vlog/still-${take.take_index}-${Date.now()}`,
    );
    stillKeys[take.take_index] = key;
    const local = `${OUT_DIR}/take-${take.take_index}-still.png`;
    await downloadTo(await presign(key), local);
    console.log(`  ${key} → ${local}`);
  }
  writeFileSync(STILLS_FILE, JSON.stringify(stillKeys));
  console.log(`\nstills index saved → ${STILLS_FILE}\nReview the PNGs in ${OUT_DIR}, then --film-b`);
}

/** Arm B step 2: animate each reviewed still as Mini's first frame. NO reference_images AND NO
 *  reference_audios — E006 (verified live 7/25): first/last frame images can't combine with ANY
 *  reference inputs. Voice is unpinned in this arm (Mini reads the quoted dialogue itself). */
async function filmB(): Promise<void> {
  const smokePlan = JSON.parse(readFileSync(PLAN_FILE, 'utf8')) as SmokePlan;
  const stillKeys = JSON.parse(readFileSync(STILLS_FILE, 'utf8')) as string[];
  const config = gorillaConfig();
  execSync(`mkdir -p ${OUT_DIR}`);
  const localClips: string[] = [];

  for (const take of smokePlan.takes) {
    const stillUrl = await presign(stillKeys[take.take_index]!);
    console.log(`\nfilming take ${take.take_index} (frame-first, no voice ref, ${take.duration_seconds}s)…`);
    const clipKey = await runVlogTake(
      {
        prompt: buildTakePrompt(config, take),
        durationSeconds: take.duration_seconds,
        referenceImages: [],
        firstFrameImage: stillUrl,
      },
      `smoke-vlog/takeB-${take.take_index}-${Date.now()}`,
    );
    const local = `${OUT_DIR}/take-${take.take_index}-B.mp4`;
    await downloadTo(await presign(clipKey), local);
    console.log(`  archived ${clipKey} → ${local}`);
    localClips.push(local);
  }
  await concatClips(localClips, 'final-B');
}

async function plan(topic: string, vibe?: string): Promise<void> {
  const takeSeconds = allocateTakes(TOTAL_SECONDS);
  console.log(`allocation for ${TOTAL_SECONDS}s: [${takeSeconds.join(', ')}]`);
  const takes = await planVlogTakes({ character: gorillaConfig(), topic, vibe, takeSeconds });
  const smokePlan: SmokePlan = { topic, vibe, totalSeconds: TOTAL_SECONDS, takes };
  writeFileSync(PLAN_FILE, JSON.stringify(smokePlan, null, 2));
  console.log('\n=== SCRIPT (review before --film) ===');
  for (const take of takes) {
    console.log(`\n--- take ${take.take_index} (${take.duration_seconds}s) [${take.framing_tag} / ${take.setting_tag}]`);
    console.log(`setting:  ${take.setting}`);
    console.log(`action:   ${take.visual_direction}`);
    console.log(`line:     "${take.spoken_line}"`);
    console.log(`delivery: ${take.voice_direction}`);
    console.log(`prompt:   ${buildTakePrompt(gorillaConfig(), take)}`);
  }
  console.log(`\nplan saved → ${PLAN_FILE}`);
}

async function film(): Promise<void> {
  const smokePlan = JSON.parse(readFileSync(PLAN_FILE, 'utf8')) as SmokePlan;
  const config = gorillaConfig();
  const referenceImages = [await presign(SHEET_KEY)];
  const referenceAudios = [await presign(AUDIO_KEY)];
  execSync(`mkdir -p ${OUT_DIR}`);
  const localClips: string[] = [];

  for (const take of smokePlan.takes) {
    const prompt = buildTakePrompt(config, take);
    console.log(`\nfilming take ${take.take_index} (text-only, ${take.duration_seconds}s)…`);
    const clipKey = await runVlogTake(
      { prompt, durationSeconds: take.duration_seconds, referenceImages, referenceAudios },
      `smoke-vlog/take-${take.take_index}-${Date.now()}`,
    );
    const local = `${OUT_DIR}/take-${take.take_index}-A.mp4`;
    await downloadTo(await presign(clipKey), local);
    console.log(`  archived ${clipKey} → ${local}`);
    localClips.push(local);
  }
  await concatClips(localClips, 'final-A');
}

/** Arm C (2026-07-25, Andrew's read of the E006 scope): stills passed as REFERENCE_IMAGES (legal
 *  with reference_audios — the ban is only on first/last-frame `image` combining with refs).
 *  Voice stays pinned; the open question is how faithfully Mini follows the still's composition
 *  when it's a reference rather than the literal first frame. Same plan/stills as arm B. */
async function filmC(): Promise<void> {
  const smokePlan = JSON.parse(readFileSync(PLAN_FILE, 'utf8')) as SmokePlan;
  const stillKeys = JSON.parse(readFileSync(STILLS_FILE, 'utf8')) as string[];
  const config = gorillaConfig();
  const referenceAudios = [await presign(AUDIO_KEY)];
  execSync(`mkdir -p ${OUT_DIR}`);
  const localClips: string[] = [];

  for (const take of smokePlan.takes) {
    const stillUrl = await presign(stillKeys[take.take_index]!);
    console.log(`\nfilming take ${take.take_index} (still-as-reference + voice pin, ${take.duration_seconds}s)…`);
    const clipKey = await runVlogTake(
      {
        prompt: buildTakePrompt(config, take),
        durationSeconds: take.duration_seconds,
        referenceImages: [stillUrl],
        referenceAudios,
      },
      `smoke-vlog/takeC-${take.take_index}-${Date.now()}`,
    );
    const local = `${OUT_DIR}/take-${take.take_index}-C.mp4`;
    await downloadTo(await presign(clipKey), local);
    console.log(`  archived ${clipKey} → ${local}`);
    localClips.push(local);
  }
  await concatClips(localClips, 'final-C');
}

async function main(): Promise<void> {
  const argv = process.argv;
  if (argv.includes('--upload-assets')) return uploadAssets();
  if (argv.includes('--plan')) {
    const topicIdx = argv.indexOf('--topic');
    const topic = topicIdx >= 0 ? argv[topicIdx + 1] : undefined;
    if (!topic) throw new Error('--plan requires --topic "..."');
    const vibeIdx = argv.indexOf('--vibe');
    const vibe = vibeIdx >= 0 ? argv[vibeIdx + 1] : undefined;
    return plan(topic, vibe);
  }
  if (argv.includes('--film')) return film();
  if (argv.includes('--stills')) return stills();
  if (argv.includes('--film-b')) return filmB();
  if (argv.includes('--film-c')) return filmC();
  console.log('usage: --upload-assets | --plan --topic "..." [--vibe "..."] | --film (arm A) | --stills | --film-b (arm B) | --film-c (arm C)');
}

main().catch((e) => { console.error('smoke failed:', e); process.exit(1); });
