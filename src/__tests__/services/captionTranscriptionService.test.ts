// src/__tests__/services/captionTranscriptionService.test.ts
// Phase 13 Plan 07 (SC5 auto-generate): word-level Whisper transcription -> line-level caption
// cue drafts. Mocks child_process (no real ffmpeg spawn), node:fs/promises (no real temp-file
// I/O), archivalService (no real R2 presign), and global.fetch (no real network) — the same
// mocking-at-the-I/O-boundary convention as openaiScriptService.test.ts / hiveService.test.ts.

jest.mock('../../config', () => ({
  config: { openaiApiKey: 'mock-openai-key' },
}));

const mockExecFile = jest.fn(
  (
    _cmd: string,
    _args: string[],
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(null, '', '');
  },
);
jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) =>
    (mockExecFile as unknown as (...a: unknown[]) => void)(...args),
}));

jest.mock('node:fs/promises', () => ({
  mkdtemp: jest.fn().mockResolvedValue('/tmp/caption-transcribe-mock'),
  rm: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(Buffer.from('fake-audio-bytes')),
}));

jest.mock('../../services/archivalService', () => ({
  getUploadPresignedUrl: jest.fn().mockResolvedValue('https://r2.example.com/presigned-clip.mp4'),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import {
  transcribeToWordCues,
  groupWordsIntoCues,
  TranscriptionError,
} from '../../services/captionTranscriptionService';

beforeEach(() => {
  jest.clearAllMocks();
  mockExecFile.mockImplementation((_cmd, _args, cb) => cb(null, '', ''));
});

// ─── groupWordsIntoCues (pure function) ────────────────────────────────────────

describe('groupWordsIntoCues', () => {
  it('maps a Whisper verbose_json words array 1:1 into a single cue when under the word cap and gap threshold', () => {
    const words = [
      { word: 'hello', start: 0, end: 0.3 },
      { word: 'there', start: 0.3, end: 0.6 },
      { word: 'world', start: 0.6, end: 0.9 },
    ];

    const cues = groupWordsIntoCues(words);

    expect(cues).toHaveLength(1);
    expect(cues[0].startSeconds).toBe(0);
    expect(cues[0].endSeconds).toBe(0.9);
    expect(cues[0].words).toEqual([
      { text: 'hello', startSeconds: 0, endSeconds: 0.3 },
      { text: 'there', startSeconds: 0.3, endSeconds: 0.6 },
      { text: 'world', startSeconds: 0.6, endSeconds: 0.9 },
    ]);
  });

  it('starts a new cue once a cue already holds 5 words (short-form single-line cap)', () => {
    const words = Array.from({ length: 6 }, (_, i) => ({
      word: `w${i}`,
      start: i * 0.2,
      end: i * 0.2 + 0.15,
    }));

    const cues = groupWordsIntoCues(words);

    expect(cues).toHaveLength(2);
    expect(cues[0].words).toHaveLength(5);
    expect(cues[1].words).toHaveLength(1);
  });

  it('starts a new cue at a strong conversational pause below the old 0.8s threshold', () => {
    const words = [
      { word: 'hello', start: 0, end: 0.3 },
      { word: 'world', start: 0.3, end: 0.6 },
      { word: 'later', start: 1.1, end: 1.4 },
    ];

    const cues = groupWordsIntoCues(words);

    expect(cues).toHaveLength(2);
    expect(cues[0].words.map((w) => w.text)).toEqual(['hello', 'world']);
    expect(cues[1].words.map((w) => w.text)).toEqual(['later']);
    expect(cues[1].startSeconds).toBe(1.1);
  });

  it('uses a smaller pause as a phrase break once enough words are visible', () => {
    const words = [
      { word: 'France', start: 0, end: 0.25 },
      { word: 'World', start: 0.25, end: 0.5 },
      { word: 'Cup', start: 0.5, end: 0.75 },
      { word: 'game', start: 0.75, end: 1 },
      { word: 'Oh', start: 1.3, end: 1.5 },
      { word: 'no', start: 1.5, end: 1.7 },
      { word: 'need', start: 1.7, end: 1.9 },
    ];

    const cues = groupWordsIntoCues(words);

    expect(cues.map((cue) => cue.words.map((word) => word.text))).toEqual([
      ['France', 'World', 'Cup', 'game'],
      ['Oh', 'no', 'need'],
    ]);
  });

  it('caps visual length even when the cue has fewer than 5 words', () => {
    const words = [
      { word: 'extraordinary', start: 0, end: 0.3 },
      { word: 'international', start: 0.3, end: 0.6 },
      { word: 'competition', start: 0.6, end: 0.9 },
    ];

    const cues = groupWordsIntoCues(words);

    expect(cues.map((cue) => cue.words.map((word) => word.text))).toEqual([
      ['extraordinary', 'international'],
      ['competition'],
    ]);
  });

  it('starts a new cue after sentence punctuation', () => {
    const words = [
      { word: 'We', start: 0, end: 0.2 },
      { word: 'won.', start: 0.2, end: 0.5 },
      { word: 'Nobody', start: 0.5, end: 0.8 },
      { word: 'expected', start: 0.8, end: 1.1 },
      { word: 'it.', start: 1.1, end: 1.4 },
    ];

    const cues = groupWordsIntoCues(words);

    expect(cues.map((cue) => cue.words.map((word) => word.text))).toEqual([
      ['We', 'won.'],
      ['Nobody', 'expected', 'it.'],
    ]);
  });

  it('caps a cue at 3 seconds even during continuous speech', () => {
    const words = [
      { word: 'one', start: 0, end: 0.8 },
      { word: 'two', start: 0.8, end: 1.6 },
      { word: 'three', start: 1.6, end: 2.4 },
      { word: 'four', start: 2.4, end: 3.2 },
    ];

    const cues = groupWordsIntoCues(words);

    expect(cues.map((cue) => cue.words.map((word) => word.text))).toEqual([
      ['one', 'two', 'three'],
      ['four'],
    ]);
  });

  it('returns an empty array for an empty words array (no crash)', () => {
    expect(groupWordsIntoCues([])).toEqual([]);
  });
});

// ─── transcribeToWordCues (I/O orchestration, all seams mocked) ────────────────

describe('transcribeToWordCues', () => {
  it('downloads the clip, extracts audio via ffmpeg, POSTs to OpenAI, and groups the result into cues', async () => {
    mockFetch
      // 1st fetch: downloadR2KeyToFile's presigned-URL GET
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
      // 2nd fetch: the OpenAI Whisper transcription POST
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          words: [
            { word: 'hi', start: 0, end: 0.4 },
            { word: 'there', start: 0.4, end: 0.8 },
          ],
        }),
      });

    const cues = await transcribeToWordCues('projects/proj-1/clips/clip-1.mp4');

    expect(cues).toHaveLength(1);
    expect(cues[0].words.map((w) => w.text)).toEqual(['hi', 'there']);

    // ffmpeg was invoked with a fixed argv array extracting a compressed audio-only stem
    expect(mockExecFile).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-vn', '-c:a', 'aac', '-b:a', '96k']),
      expect.any(Function),
    );

    // OpenAI request carries word-level timestamp_granularities and the whisper-1 model
    const openaiCall = mockFetch.mock.calls[1];
    expect(openaiCall[0]).toBe('https://api.openai.com/v1/audio/transcriptions');
    const form = openaiCall[1].body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('timestamp_granularities[]')).toBe('word');
  });

  it('throws a TranscriptionError when the OpenAI call returns a non-OK response', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' });

    await expect(transcribeToWordCues('projects/proj-1/clips/clip-1.mp4')).rejects.toThrow(
      TranscriptionError,
    );
  });

  it('throws a TranscriptionError when the OpenAI call rejects (network error)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
      .mockRejectedValueOnce(new Error('network down'));

    await expect(transcribeToWordCues('projects/proj-1/clips/clip-1.mp4')).rejects.toThrow(
      TranscriptionError,
    );
  });

  it('throws a TranscriptionError when the clip download itself fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    await expect(transcribeToWordCues('projects/proj-1/clips/clip-1.mp4')).rejects.toThrow(
      TranscriptionError,
    );
  });
});
