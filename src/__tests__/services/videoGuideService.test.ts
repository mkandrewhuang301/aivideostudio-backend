// src/__tests__/services/videoGuideService.test.ts
// Unit tests for continuationGuideFromVideo — inline-video payload shape (480p downscale →
// base64 video/mp4 part), hint wiring into the instruction, and the fail-loud VideoGuideError
// contract (never a silent empty).

jest.mock('../../config', () => ({
  config: { geminiApiKey: 'test-gemini-key', videoGuideModel: 'gemini-3.5-flash' },
}));

// ffmpeg is spawned via promisify(execFile) at module scope — stub execFile to succeed and
// fs/promises so the "downscaled" bytes are just a sentinel buffer.
jest.mock('child_process', () => ({
  execFile: jest.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(null)),
}));
jest.mock('node:fs/promises', () => ({
  mkdtemp: jest.fn().mockResolvedValue('/tmp/video-guide-test'),
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(Buffer.from('DOWNSCALED')),
  rm: jest.fn().mockResolvedValue(undefined),
}));

import { continuationGuideFromVideo, VideoGuideError } from '../../services/videoGuideService';

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const CLIP_URL = 'https://r2.example.com/signed/clip.mp4';

function mockClipDownload() {
  return {
    ok: true,
    headers: new Map([['content-length', '1024']]),
    arrayBuffer: async () => new Uint8Array(1024).buffer,
  };
}

function okGemini(text: string) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  };
}

function geminiBody(): { contents: Array<{ parts: Array<Record<string, unknown>> }> } {
  // Second fetch call is the Gemini POST (first is the clip download).
  return JSON.parse(fetchMock.mock.calls[1][1].body as string);
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('continuationGuideFromVideo', () => {
  it('sends the clip inline as base64 video/mp4 and returns the guide text', async () => {
    fetchMock.mockResolvedValueOnce(mockClipDownload());
    fetchMock.mockResolvedValueOnce(okGemini('  Continue the clip seamlessly.  '));

    await expect(continuationGuideFromVideo({ videoUrl: CLIP_URL })).resolves.toBe(
      'Continue the clip seamlessly.',
    );

    const parts = geminiBody().contents[0].parts;
    expect(parts[0]).toEqual({
      inlineData: { data: Buffer.from('DOWNSCALED').toString('base64'), mimeType: 'video/mp4' },
    });
    expect(String(parts[1].text)).toContain('creates the next shot after this clip');
    expect(String(parts[1].text)).toContain('NEVER name a recognizable character');
    expect(String(parts[1].text)).not.toContain('User direction:');
  });

  it('appends the moderated hint as the user direction', async () => {
    fetchMock.mockResolvedValueOnce(mockClipDownload());
    fetchMock.mockResolvedValueOnce(okGemini('He turns around.'));

    await continuationGuideFromVideo({ videoUrl: CLIP_URL, hint: 'he turns around' });

    const text = String(geminiBody().contents[0].parts[1].text);
    expect(text).toContain('User direction: he turns around');
  });

  it('targets the configured model with the api key header', async () => {
    fetchMock.mockResolvedValueOnce(mockClipDownload());
    fetchMock.mockResolvedValueOnce(okGemini('x'));

    await continuationGuideFromVideo({ videoUrl: CLIP_URL });

    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('/models/gemini-3.5-flash:generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-gemini-key');
  });

  it('throws VideoGuideError when the clip download fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(continuationGuideFromVideo({ videoUrl: CLIP_URL })).rejects.toBeInstanceOf(
      VideoGuideError,
    );
  });

  it('throws VideoGuideError on a Gemini non-OK response', async () => {
    fetchMock.mockResolvedValueOnce(mockClipDownload());
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
    await expect(continuationGuideFromVideo({ videoUrl: CLIP_URL })).rejects.toBeInstanceOf(
      VideoGuideError,
    );
  });

  it('throws VideoGuideError on empty Gemini text', async () => {
    fetchMock.mockResolvedValueOnce(mockClipDownload());
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [] }) });
    await expect(continuationGuideFromVideo({ videoUrl: CLIP_URL })).rejects.toBeInstanceOf(
      VideoGuideError,
    );
  });
});
