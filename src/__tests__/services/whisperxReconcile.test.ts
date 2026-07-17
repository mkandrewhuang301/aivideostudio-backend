import {
  buildSceneCues,
  reconcileScriptWithTiming,
} from '../../services/whisperxService';
import type { WhisperXWord } from '../../services/providers/ReplicateProvider';

function whisper(word: string, start: number, end: number): WhisperXWord {
  return { word, start, end };
}

describe('reconcileScriptWithTiming', () => {
  it('uses script text as truth while preserving index-matched timings', () => {
    const result = reconcileScriptWithTiming(
      ['The', 'moon', 'formed', 'long', 'ago'],
      [
        whisper('The', 0, 0.2),
        whisper('mune', 0.2, 0.5),
        whisper('formed', 0.5, 0.9),
        whisper('long', 0.9, 1.1),
        whisper('ago', 1.1, 1.4),
      ],
      1.4,
    );

    expect(result.map((word) => word.text)).toEqual(['The', 'moon', 'formed', 'long', 'ago']);
    expect(result[1]).toEqual({ text: 'moon', startSeconds: 0.2, endSeconds: 0.5 });
  });

  it('distributes fewer WhisperX timings without dropping script words', () => {
    const result = reconcileScriptWithTiming(
      ['The', 'moon', 'was', 'formed', 'long', 'ago'],
      [
        whisper('The', 0, 0.2),
        whisper('moon', 0.2, 0.5),
        whisper('formed', 0.8, 1.1),
        whisper('ago', 1.4, 1.7),
      ],
      1.7,
    );

    expect(result).toHaveLength(6);
    for (let index = 1; index < result.length; index += 1) {
      expect(result[index]!.startSeconds).toBeGreaterThanOrEqual(result[index - 1]!.endSeconds);
    }
  });

  it('collapses extra WhisperX entries and carries the final end time', () => {
    const result = reconcileScriptWithTiming(
      ['The', 'moon', 'formed'],
      [
        whisper('The', 0, 0.2),
        whisper('bright', 0.2, 0.4),
        whisper('moon', 0.4, 0.7),
        whisper('was', 0.7, 0.8),
        whisper('formed', 0.8, 1.2),
      ],
      1.2,
    );

    expect(result).toHaveLength(3);
    expect(result[2]!.endSeconds).toBe(1.2);
  });

  it('uniformly times every script word when WhisperX returns no words', () => {
    const result = reconcileScriptWithTiming(['one', 'two', 'three'], [], 3);

    expect(result).toEqual([
      { text: 'one', startSeconds: 0, endSeconds: 1 },
      { text: 'two', startSeconds: 1, endSeconds: 2 },
      { text: 'three', startSeconds: 2, endSeconds: 3 },
    ]);
  });
});

describe('buildSceneCues', () => {
  it('builds one cue per scene and offsets each scene timing', () => {
    const cues = buildSceneCues(
      ['Hello moon', 'Goodbye earth'],
      [
        { text: 'Hello', startSeconds: 0, endSeconds: 0.4 },
        { text: 'moon', startSeconds: 0.4, endSeconds: 0.8 },
        { text: 'Goodbye', startSeconds: 0, endSeconds: 0.5 },
        { text: 'earth', startSeconds: 0.5, endSeconds: 1 },
      ],
      [0, 2],
    );

    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({
      startSeconds: 0,
      endSeconds: 0.8,
      words: [
        { text: 'Hello', startSeconds: 0, endSeconds: 0.4 },
        { text: 'moon', startSeconds: 0.4, endSeconds: 0.8 },
      ],
    });
    expect(cues[1]).toEqual({
      startSeconds: 2,
      endSeconds: 3,
      words: [
        { text: 'Goodbye', startSeconds: 2, endSeconds: 2.5 },
        { text: 'earth', startSeconds: 2.5, endSeconds: 3 },
      ],
    });
  });
});
