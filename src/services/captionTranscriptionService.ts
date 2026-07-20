// src/services/captionTranscriptionService.ts
// Phase 13 Plan 07 (SC5 auto-generate, SC7's sibling data-source): word-level transcription of a
// project clip's audio via OpenAI Whisper, grouped into line-level caption cue drafts shaped
// exactly like project_caption_cues/project_caption_words (RESEARCH.md Interfaces).
//
// UNLIKE openaiScriptService.ts's fail-open convention: this path is USER-TRIGGERED and
// synchronous (mirrors Magic Editor's generateImageEditWithMask precedent, 09.2-08) — a
// transcription failure must surface to the caller as a clean, typed error the route turns into
// a 502, never silently return an empty/degraded cue list.

import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../config';
import { getUploadPresignedUrl } from './archivalService';

const execFileAsync = promisify(execFile);

const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-1';

// Short-form-video captions need tighter limits than conventional two-line subtitles because the
// editor intentionally renders each cue on ONE line. A word-count-only limit is not sufficient:
// seven long words can be far wider than seven short ones. Group on a combination of visual
// length, elapsed speech time, punctuation, and pauses instead.
const MAX_WORDS_PER_CUE = 5;
const MAX_CHARACTERS_PER_CUE = 30;
const MAX_CUE_DURATION_SECONDS = 3;
const STRONG_PAUSE_SECONDS = 0.45;
const SOFT_PAUSE_SECONDS = 0.25;
const MIN_WORDS_BEFORE_SOFT_BREAK = 3;

function endsSentence(text: string): boolean {
  return /[.!?…]["'”’)]*$/.test(text);
}

function endsPhrase(text: string): boolean {
  return /[,;:]["'”’)]*$/.test(text);
}

function cueCharacterCount(words: CaptionWordDraft[], nextWord?: CaptionWordDraft): number {
  return [...words, ...(nextWord ? [nextWord] : [])]
    .map((word) => Array.from(word.text).length)
    .reduce((total, length, index) => total + length + (index > 0 ? 1 : 0), 0);
}

export interface CaptionWordDraft {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface CaptionCueDraft {
  startSeconds: number;
  endSeconds: number;
  words: CaptionWordDraft[];
}

// Thrown on any OpenAI network error / non-OK response / download-or-ffmpeg failure — the route
// (POST /:id/clips/:clipId/captions/auto-generate) maps this to a clean 502.
export class TranscriptionError extends Error {}

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface WhisperVerboseJsonResponse {
  words?: WhisperWord[];
}

// T-13-11-adjacent hygiene: only ever writes under os.tmpdir()/caption-transcribe-* — scoped to
// this call, matching ffmpegProcessor.ts's per-job temp-dir convention.
async function downloadR2KeyToFile(r2Key: string, destPath: string): Promise<void> {
  const url = await getUploadPresignedUrl(r2Key);
  const response = await fetch(url);
  if (!response.ok) {
    throw new TranscriptionError(`Failed to download clip for transcription: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);
}

// execFile with a fixed argv array only (never a shell string) — same discipline as
// ffmpegProcessor.ts's runFfmpeg.
async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', args);
}

function extFromKey(r2Key: string): string {
  const ext = r2Key.split('.').pop();
  return ext ? `.${ext}` : '.mp4';
}

/**
 * Groups Whisper's flat word-timestamp array into line-level caption cue drafts. Pure function —
 * no I/O — so the readability heuristic is independently unit-testable.
 */
export function groupWordsIntoCues(words: WhisperWord[]): CaptionCueDraft[] {
  const cues: CaptionCueDraft[] = [];
  let current: CaptionCueDraft | null = null;

  for (const w of words) {
    const word: CaptionWordDraft = { text: w.word.trim(), startSeconds: w.start, endSeconds: w.end };
    if (!word.text) continue;

    const lastWord = current?.words[current.words.length - 1];
    const gapSeconds = lastWord ? word.startSeconds - lastWord.endSeconds : 0;
    const cueDurationWithWord = current ? word.endSeconds - current.startSeconds : 0;
    const previousEndsPhrase = lastWord
      ? endsSentence(lastWord.text)
        || (endsPhrase(lastWord.text) && current!.words.length >= MIN_WORDS_BEFORE_SOFT_BREAK)
      : false;
    const pauseBoundary = gapSeconds >= STRONG_PAUSE_SECONDS
      || (gapSeconds >= SOFT_PAUSE_SECONDS
        && (current?.words.length ?? 0) >= MIN_WORDS_BEFORE_SOFT_BREAK);
    const startsNewCue = !current
      || current.words.length >= MAX_WORDS_PER_CUE
      || cueCharacterCount(current.words, word) > MAX_CHARACTERS_PER_CUE
      || cueDurationWithWord > MAX_CUE_DURATION_SECONDS
      || previousEndsPhrase
      || pauseBoundary;

    if (startsNewCue) {
      current = { startSeconds: word.startSeconds, endSeconds: word.endSeconds, words: [word] };
      cues.push(current);
    } else {
      current!.words.push(word);
      current!.endSeconds = word.endSeconds;
    }
  }

  return cues;
}

/**
 * Downloads the clip at `audioSourceR2Key`, extracts a compressed audio-only stem via ffmpeg
 * (bounds Whisper's 25MB request limit), POSTs it to OpenAI's Whisper transcription endpoint with
 * word-level timestamp granularity, and groups the resulting words into line-level cue drafts.
 * Always cleans up its temp dir, even on error. Throws TranscriptionError on any failure — never
 * returns a partial/empty result silently.
 */
export async function transcribeToWordCues(audioSourceR2Key: string): Promise<CaptionCueDraft[]> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'caption-transcribe-'));
  try {
    const clipPath = path.join(tempDir, `source${extFromKey(audioSourceR2Key)}`);
    const audioPath = path.join(tempDir, 'audio.m4a');

    await downloadR2KeyToFile(audioSourceR2Key, clipPath);
    await runFfmpeg(['-y', '-i', clipPath, '-vn', '-c:a', 'aac', '-b:a', '96k', audioPath]);

    const audioBuffer = await readFile(audioPath);
    const form = new FormData();
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('file', new Blob([audioBuffer], { type: 'audio/mp4' }), 'audio.m4a');

    const response = await fetch(OPENAI_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        // No Content-Type — fetch's FormData sets the multipart boundary itself.
      },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new TranscriptionError(`OpenAI transcription failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as WhisperVerboseJsonResponse;
    return groupWordsIntoCues(json.words ?? []);
  } catch (err) {
    if (err instanceof TranscriptionError) throw err;
    throw new TranscriptionError(
      `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
