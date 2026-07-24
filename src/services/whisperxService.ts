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

// ─── Clause-aware cue builder (B7) ──────────────────────────────────────────────────────────
// Ported from the spikeCustomSync.ts throwaway rebuild's clauseLens/cues logic (the validated
// fix for the "…the sun. Plants…" and "…a plant's very own superpower" cases). Count-based
// chunking (fixed word/char caps) can strand a lone function word ("a") at a chunk boundary or
// split a clause mid-thought; breaking on punctuation FIRST avoids both.
const MAX_CLAUSE_WORDS = 6;

// Words a cue should never END on — they belong with what follows (articles, conjunctions,
// prepositions, possessives). Mirrors spikeCustomSync.ts's BAD_TRAILING set.
const BAD_TRAILING_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'with', 'that', 'this',
  'their', 'his', 'her', 'its', 'our', 'your', 'my', 'in', 'on', 'for', 'at',
  'from', 'up', 'into', 'over', 'very',
]);

function isBadTrailingWord(word: string): boolean {
  return BAD_TRAILING_WORDS.has(word.toLowerCase().replace(/[^a-z']/g, ''));
}

/**
 * PURE: splits one scene's punctuated narration_line into clause-aware cue boundaries and slices
 * the (already index-aligned) word-timing array accordingly.
 *   1. Break on punctuation FIRST — commas and sentence terminators are hard cue boundaries.
 *   2. Sub-split only clauses longer than MAX_CLAUSE_WORDS, into BALANCED pieces (not greedy).
 *   3. Never end a non-final piece of a sub-split clause on a function word — defer it forward.
 *   4. A cue never crosses a clause's parent scene (the caller only ever passes one scene's
 *      words), so it can never cross a scene boundary either.
 * `words` must be 1:1 index-aligned with `narration`'s whitespace-token count — guaranteed
 * upstream because reconcileScriptWithTiming always returns exactly scriptWords.length entries,
 * and scriptWords is built the same way (`narration_line.split(/\s+/)`) as this function's own
 * clause tokenization. If a caller ever violates that (drift), this degrades to one cue for the
 * whole scene rather than mis-indexing into `words`.
 */
export function buildClauseAwareCues(
  narration: string,
  words: CaptionWordDraft[],
): CaptionCueDraft[] {
  if (words.length === 0) return [];

  const clauseLengths = narration
    .split(/(?<=[,.?!;:])\s+/)
    .map((clause) => clause.trim().replace(/[,.?!;:]+$/, '').trim())
    .filter(Boolean)
    .map((clause) => clause.split(/\s+/).length);

  const clauseTotal = clauseLengths.reduce((sum, length) => sum + length, 0);
  const effectiveClauseLengths = clauseTotal === words.length ? clauseLengths : [words.length];

  const boundaries: Array<[start: number, end: number]> = [];
  let cursor = 0;
  for (const clauseLength of effectiveClauseLengths) {
    let remaining = clauseLength;
    let pieceCount = Math.ceil(clauseLength / MAX_CLAUSE_WORDS);
    let start = cursor;
    while (pieceCount > 0) {
      let end = start + Math.ceil(remaining / pieceCount) - 1;
      // Only a SUB-SPLIT piece (there's a next piece in this same clause to defer into) needs
      // the bad-trailing-word guard — a clause's own natural (punctuation) boundary is authored
      // by the script and essentially never ends mid-thought.
      if (pieceCount > 1) {
        while (end > start && isBadTrailingWord(words[end]!.text)) end -= 1;
      }
      boundaries.push([start, end]);
      remaining -= end - start + 1;
      start = end + 1;
      pieceCount -= 1;
    }
    cursor += clauseLength;
  }

  return boundaries.map(([start, end]) => {
    const cueWords = words.slice(start, end + 1);
    return {
      startSeconds: cueWords[0]!.startSeconds,
      endSeconds: cueWords[cueWords.length - 1]!.endSeconds,
      words: cueWords,
    };
  });
}

/** PURE: groups flattened per-scene word timings into clause-aware cues per narration line, each
 * offset into the concatenated narration timeline. A scene's narration may produce multiple
 * cues (B7); a cue never crosses a scene boundary because clause splitting runs per scene. */
export function buildSceneCues(
  sceneNarrations: string[],
  words: CaptionWordDraft[],
  sceneStartOffsets: number[],
): CaptionCueDraft[] {
  let wordCursor = 0;
  const cues: CaptionCueDraft[] = [];

  sceneNarrations.forEach((narration, sceneIndex) => {
    const wordCount = narration.trim() ? narration.trim().split(/\s+/).length : 0;
    const offset = sceneStartOffsets[sceneIndex] ?? 0;
    const sceneWords = words.slice(wordCursor, wordCursor + wordCount).map((word) => ({
      text: word.text,
      startSeconds: word.startSeconds + offset,
      endSeconds: word.endSeconds + offset,
    }));
    wordCursor += wordCount;

    cues.push(...buildClauseAwareCues(narration, sceneWords));
  });

  return cues;
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
