// THROWAWAY / OPERATIONAL script — NOT imported by the app, run manually exactly once (per voice
// roster change) with prod env (funded Replicate account + real R2 creds):
//   npx tsx src/scripts/genVoicePreviews.ts
//
// Pre-generates the tap-to-preview audio samples for the Video Summarizer voice picker: the 6
// Google Chirp3-HD preset voices (src/config/formats.ts's video-explainer voices) plus the cloned
// "voiceA" anime-narrator voice. Uploads each sample to R2 at the exact `voice-previews/<id
// lowercased>.wav` key that formats.ts's preview_url fields already point at — DO NOT change the
// extension here without updating those keys to match (they must stay identical).
//
// Presets render through generateTtsWav (Google TTS) — the same engine/model the worker actually
// renders on (see videoSummaryWorker.resolveSummaryVoice — 2026-07-24: qwen preset speakers carried
// a strong Chinese accent, so presets moved back to Google, keeping only the voiceA clone on qwen).
// voiceA renders through mode:'voice_clone' (a hosted reference clip + transcript), never
// mode:'custom_voice' — it is not a Google preset and only qwen3-tts can clone it.

import 'dotenv/config';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../storage/r2';
import { getUploadPresignedUrl, uploadBufferToR2 } from '../services/archivalService';
import { replicateQwenTts } from '../services/providers/ReplicateProvider';
// Import the voice constants + TTS helper straight from geminiTtsService (side-effect-free).
// NOT from videoSummaryWorker — importing that instantiates the BullMQ Worker + a Redis
// connection, which hangs this operational script on the worker's Redis connect.
import {
  generateTtsWav,
  VIDEO_SUMMARY_VOICE_STYLE_PROMPT,
  VOICE_A_REFERENCE_R2_KEY,
  VOICE_A_TRANSCRIPT,
} from '../services/geminiTtsService';
import { FORMATS_BY_ID } from '../config/formats';

/** Fixed neutral recap-flavored sample line, ~2-3s at the summarizer's brisk delivery pace. */
const PREVIEW_LINE = "Here's what went down in the last episode.";

/**
 * Google Chirp3-HD preset voice ids. Must match src/config/formats.ts's video-explainer voices
 * exactly (excluding 'voiceA', the qwen clone exception).
 */
const GOOGLE_PRESET_VOICES = ['Kore', 'Zephyr', 'Aoede', 'Puck', 'Charon', 'Orus'] as const;

/**
 * Google TTS model id the worker actually renders the summarizer's narration on. The
 * video-explainer format itself carries no tts_model field (VideoSummaryFormatDef doesn't have
 * one) — the worker reuses the AI Explainer format's tts_model, so previews must match that same
 * source to sound like real production output.
 */
const SUMMARY_TTS_MODEL_ID = FORMATS_BY_ID.explainer?.tts_model;

/** `voice-previews/<id-lowercased>.wav` — MUST match formats.ts's preview_url keys exactly. */
function previewR2Key(voiceId: string): string {
  return `voice-previews/${voiceId.toLowerCase()}.wav`;
}

/** Confirms the voice_clone reference clip is actually hosted before wasting a Replicate call on
 *  it. Per the 2026-07-24 clarification: if it's missing, this is a dependency blocker for the
 *  human to resolve (upload/re-host the clip) — never invent a fallback reference. */
async function assertVoiceAReferenceClipExists(): Promise<void> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: VOICE_A_REFERENCE_R2_KEY }));
  } catch (error) {
    throw new Error(
      `BLOCKER: voiceA reference clip missing at R2 key '${VOICE_A_REFERENCE_R2_KEY}' — ` +
      'upload/re-host it before running this script. voiceA preview generation cannot proceed ' +
      `without it. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

async function generatePresetPreview(voiceId: string): Promise<Buffer> {
  if (!SUMMARY_TTS_MODEL_ID) {
    throw new Error('BLOCKER: FORMATS_BY_ID.explainer.tts_model is unavailable — cannot render Google preview.');
  }
  return generateTtsWav(SUMMARY_TTS_MODEL_ID, PREVIEW_LINE, voiceId, VIDEO_SUMMARY_VOICE_STYLE_PROMPT);
}

async function generateVoiceAPreview(): Promise<Buffer> {
  return replicateQwenTts({
    text: PREVIEW_LINE,
    mode: 'voice_clone',
    referenceAudioUrl: await getUploadPresignedUrl(VOICE_A_REFERENCE_R2_KEY),
    referenceText: VOICE_A_TRANSCRIPT,
    styleInstruction: VIDEO_SUMMARY_VOICE_STYLE_PROMPT,
    language: 'English',
  });
}

async function main(): Promise<void> {
  await assertVoiceAReferenceClipExists();

  for (const voiceId of GOOGLE_PRESET_VOICES) {
    const audio = await generatePresetPreview(voiceId);
    const key = previewR2Key(voiceId);
    await uploadBufferToR2(audio, key, 'audio/wav');
    console.log(`Uploaded ${key}`);
  }

  const voiceAAudio = await generateVoiceAPreview();
  const voiceAKey = previewR2Key('voiceA');
  await uploadBufferToR2(voiceAAudio, voiceAKey, 'audio/wav');
  console.log(`Uploaded ${voiceAKey}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
