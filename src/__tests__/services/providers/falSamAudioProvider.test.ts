// src/__tests__/services/providers/falSamAudioProvider.test.ts
// Unit tests for FalSamAudioProvider — the fal field-inversion crossover, request-shape pins
// (reranking_candidates:1, output_format:'mp3'), missing-output rejection, and error mapping.
// fal.subscribe and global fetch are mocked: no live fal call, no network.
//
// The crossover test is the load-bearing one. fal's SAM Audio schema names its outputs
// target=isolated-prompt-stem / residual=everything-else, but live outputs ship the two buffers
// swapped relative to those names (confirmed by ear 2026-07-27). The provider crosses them so
// AudioSeparationResult.target really is the isolated stem. If someone "fixes" the apparent
// mismatch in the provider by un-crossing it, this test fails.

jest.mock('@fal-ai/client', () => {
  // Mirrors the real ApiError's { message, status } constructor so the provider's
  // `error instanceof ApiError` branch and its `.status` read behave as in production.
  class ApiError extends Error {
    readonly status: number;
    constructor({ message, status }: { message: string; status: number }) {
      super(message);
      this.status = status;
    }
  }
  return { fal: { subscribe: jest.fn() }, ApiError };
});

import { fal, ApiError } from '@fal-ai/client';
import { FalSamAudioProvider, AudioSeparationProviderError } from '../../../services/providers/FalSamAudioProvider';

const mockSubscribe = fal.subscribe as jest.Mock;
const provider = new FalSamAudioProvider();

const TARGET_URL = 'https://fal.media/out/target.mp3';
const RESIDUAL_URL = 'https://fal.media/out/residual.mp3';

// Distinct payloads so a crossed vs uncrossed mapping is unambiguous in assertions.
const BYTES_AT_TARGET_URL = Buffer.from('bytes-served-at-fal-target-url');
const BYTES_AT_RESIDUAL_URL = Buffer.from('bytes-served-at-fal-residual-url');

function wireFetch() {
  const fetchMock = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => {
      const buf = url === TARGET_URL ? BYTES_AT_TARGET_URL : BYTES_AT_RESIDUAL_URL;
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  }));
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

function wireHappyPath() {
  mockSubscribe.mockResolvedValue({
    data: { target: { url: TARGET_URL }, residual: { url: RESIDUAL_URL }, duration: 10 },
    requestId: 'req-1',
  });
  return wireFetch();
}

const INPUT = {
  model: 'fal-ai/sam-audio/separate',
  audioUrl: 'https://r2.example/source.m4a',
  prompt: 'background music',
  durationSeconds: 10,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('FalSamAudioProvider.separate — fal field inversion', () => {
  it("crosses fal's fields: result.target carries the bytes fal served at its `residual` URL", async () => {
    wireHappyPath();

    const result = await provider.separate(INPUT);

    // The isolated prompt stem we hand back must be what fal served at its residual URL.
    expect(result.target.equals(BYTES_AT_RESIDUAL_URL)).toBe(true);
    expect(result.residual.equals(BYTES_AT_TARGET_URL)).toBe(true);
    // Guard against a well-meaning "fix" that maps the fields straight through.
    expect(result.target.equals(BYTES_AT_TARGET_URL)).toBe(false);
  });

  it('still fetches both fal URLs (the crossover is a mapping, not a re-fetch)', async () => {
    const fetchMock = wireHappyPath();
    await provider.separate(INPUT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual([RESIDUAL_URL, TARGET_URL].sort());
  });

  it('reports mp3 mime and passes the fal request id through', async () => {
    wireHappyPath();
    const result = await provider.separate(INPUT);
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.providerRequestId).toBe('req-1');
  });
});

describe('FalSamAudioProvider.separate — request shape', () => {
  it('pins reranking_candidates:1 (the documented cost multiplier) and mp3 output', async () => {
    wireHappyPath();
    await provider.separate(INPUT);

    expect(mockSubscribe).toHaveBeenCalledWith('fal-ai/sam-audio/separate', {
      input: {
        audio_url: INPUT.audioUrl,
        prompt: INPUT.prompt,
        reranking_candidates: 1,
        output_format: 'mp3',
      },
    });
  });
});

describe('FalSamAudioProvider.separate — failure mapping', () => {
  it.each([
    ['target', { residual: { url: RESIDUAL_URL } }],
    ['residual', { target: { url: TARGET_URL } }],
  ])('throws a retryable no_output error when the %s url is missing', async (_label, data) => {
    mockSubscribe.mockResolvedValue({ data, requestId: 'req-1' });
    wireFetch();

    await expect(provider.separate(INPUT)).rejects.toMatchObject({
      code: 'no_output',
      retryable: true,
    });
  });

  it('maps a 4xx fal ApiError to a NON-retryable provider_rejected (the request itself was bad)', async () => {
    mockSubscribe.mockRejectedValue(new ApiError({ message: 'unprocessable', status: 422 }));
    await expect(provider.separate(INPUT)).rejects.toMatchObject({
      code: 'provider_rejected',
      retryable: false,
    });
  });

  it.each([429, 500, 503])('maps a %s fal ApiError to a retryable provider_unavailable', async (status) => {
    mockSubscribe.mockRejectedValue(new ApiError({ message: `fal ${status}`, status }));
    await expect(provider.separate(INPUT)).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
  });

  it('maps an unknown throw to a retryable provider_unavailable', async () => {
    mockSubscribe.mockRejectedValue(new Error('socket hang up'));
    await expect(provider.separate(INPUT)).rejects.toBeInstanceOf(AudioSeparationProviderError);
    await expect(provider.separate(INPUT)).rejects.toMatchObject({ retryable: true });
  });

  it('surfaces a retryable fetch_failed when an output URL 404s (expired provider URL)', async () => {
    mockSubscribe.mockResolvedValue({
      data: { target: { url: TARGET_URL }, residual: { url: RESIDUAL_URL } },
      requestId: 'req-1',
    });
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: false, status: 404 }));

    await expect(provider.separate(INPUT)).rejects.toMatchObject({
      code: 'fetch_failed',
      retryable: true,
    });
  });
});
