import type {
  CaptionCueDraft,
  CaptionWordDraft,
} from './captionTranscriptionService';
import {
  transcribeWordTimings,
  type WhisperXWord,
} from './providers/ReplicateProvider';

export class WhisperXError extends Error {}

interface Anchor {
  scriptIndex: number;
  whisperIndex: number;
}

function normalizeToken(token: string): string {
  return token.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function uniformWords(
  scriptWords: string[],
  startSeconds: number,
  endSeconds: number,
): CaptionWordDraft[] {
  if (scriptWords.length === 0) return [];
  const start = Math.max(0, startSeconds);
  const end = Math.max(start, endSeconds);
  const step = (end - start) / scriptWords.length;
  return scriptWords.map((text, index) => ({
    text,
    startSeconds: start + step * index,
    endSeconds: start + step * (index + 1),
  }));
}

function findAnchors(scriptWords: string[], whisperWords: WhisperXWord[]): Anchor[] {
  const anchors: Anchor[] = [];
  let whisperCursor = 0;

  for (let scriptIndex = 0; scriptIndex < scriptWords.length; scriptIndex += 1) {
    const scriptToken = normalizeToken(scriptWords[scriptIndex]!);
    if (!scriptToken) continue;

    for (let whisperIndex = whisperCursor; whisperIndex < whisperWords.length; whisperIndex += 1) {
      if (normalizeToken(whisperWords[whisperIndex]!.word) === scriptToken) {
        anchors.push({ scriptIndex, whisperIndex });
        whisperCursor = whisperIndex + 1;
        break;
      }
    }
  }

  return anchors;
}

/** PURE: script text is truth and WhisperX contributes timing only. */
export function reconcileScriptWithTiming(
  scriptWords: string[],
  whisperWords: WhisperXWord[],
  audioDurationSeconds: number,
): CaptionWordDraft[] {
  if (scriptWords.length === 0) return [];
  if (whisperWords.length === 0) {
    return uniformWords(scriptWords, 0, audioDurationSeconds);
  }
  if (scriptWords.length === whisperWords.length) {
    return scriptWords.map((text, index) => ({
      text,
      startSeconds: whisperWords[index]!.start,
      endSeconds: whisperWords[index]!.end,
    }));
  }

  const anchors = findAnchors(scriptWords, whisperWords);
  if (anchors.length === 0) {
    return uniformWords(
      scriptWords,
      whisperWords[0]!.start,
      whisperWords[whisperWords.length - 1]!.end,
    );
  }

  const result: Array<CaptionWordDraft | undefined> = new Array(scriptWords.length);
  const boundaries: Anchor[] = [
    { scriptIndex: -1, whisperIndex: -1 },
    ...anchors,
    { scriptIndex: scriptWords.length, whisperIndex: whisperWords.length },
  ];

  for (const anchor of anchors) {
    const timing = whisperWords[anchor.whisperIndex]!;
    result[anchor.scriptIndex] = {
      text: scriptWords[anchor.scriptIndex]!,
      startSeconds: timing.start,
      endSeconds: timing.end,
    };
  }

  for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
    const previous = boundaries[boundaryIndex]!;
    const next = boundaries[boundaryIndex + 1]!;
    const scriptStart = previous.scriptIndex + 1;
    const scriptEnd = next.scriptIndex;
    if (scriptStart >= scriptEnd) continue;

    const whisperStart = previous.whisperIndex + 1;
    const whisperEnd = next.whisperIndex;
    const unmatchedWhisper = whisperWords.slice(whisperStart, whisperEnd);
    const previousEnd = previous.scriptIndex >= 0
      ? whisperWords[previous.whisperIndex]!.end
      : 0;
    const nextStart = next.scriptIndex < scriptWords.length
      ? whisperWords[next.whisperIndex]!.start
      : Math.max(audioDurationSeconds, whisperWords[whisperWords.length - 1]!.end);
    const spanStart = unmatchedWhisper[0]?.start ?? previousEnd;
    const spanEnd = unmatchedWhisper[unmatchedWhisper.length - 1]?.end ?? nextStart;
    const distributed = uniformWords(
      scriptWords.slice(scriptStart, scriptEnd),
      spanStart,
      spanEnd,
    );
    distributed.forEach((word, index) => {
      result[scriptStart + index] = word;
    });
  }

  const reconciled = result.map((word, index) => word ?? {
    text: scriptWords[index]!,
    startSeconds: 0,
    endSeconds: 0,
  });

  let previousEnd = 0;
  for (const word of reconciled) {
    word.startSeconds = Math.max(previousEnd, word.startSeconds);
    word.endSeconds = Math.max(word.startSeconds, word.endSeconds);
    previousEnd = word.endSeconds;
  }
  reconciled[reconciled.length - 1]!.endSeconds = Math.max(
    reconciled[reconciled.length - 1]!.endSeconds,
    whisperWords[whisperWords.length - 1]!.end,
  );
  return reconciled;
}

/** PURE: groups flattened per-scene word timings into one offset cue per narration line. */
export function buildSceneCues(
  sceneNarrations: string[],
  words: CaptionWordDraft[],
  sceneStartOffsets: number[],
): CaptionCueDraft[] {
  let wordCursor = 0;
  return sceneNarrations.map((narration, sceneIndex) => {
    const wordCount = narration.trim() ? narration.trim().split(/\s+/).length : 0;
    const offset = sceneStartOffsets[sceneIndex] ?? 0;
    const sceneWords = words.slice(wordCursor, wordCursor + wordCount).map((word) => ({
      text: word.text,
      startSeconds: word.startSeconds + offset,
      endSeconds: word.endSeconds + offset,
    }));
    wordCursor += wordCount;

    return {
      startSeconds: sceneWords[0]?.startSeconds ?? offset,
      endSeconds: sceneWords[sceneWords.length - 1]?.endSeconds ?? offset,
      words: sceneWords,
    };
  });
}

/** I/O wrapper: presigned narration URL to script-truth word drafts. */
export async function getWordTimings(
  audioUrl: string,
  scriptWords: string[],
  audioDurationSeconds: number,
): Promise<CaptionWordDraft[]> {
  try {
    const whisperWords = await transcribeWordTimings(audioUrl);
    return reconcileScriptWithTiming(scriptWords, whisperWords, audioDurationSeconds);
  } catch (err) {
    if (err instanceof WhisperXError) throw err;
    throw new WhisperXError(
      `WhisperX transcription failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
