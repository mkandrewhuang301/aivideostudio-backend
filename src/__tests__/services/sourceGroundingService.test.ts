const mockPdfGetText = jest.fn();
const mockPdfDestroy = jest.fn();
const mockPdfConstructor = jest.fn().mockImplementation(() => ({
  getText: mockPdfGetText,
  destroy: mockPdfDestroy,
}));
const mockLookup = jest.fn();

jest.mock('../../config', () => ({
  config: {
    openaiApiKey: 'mock-openai-key',
  },
}));

jest.mock('pdf-parse', () => ({
  PDFParse: mockPdfConstructor,
}));

jest.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

import { buildGroundingText } from '../../services/sourceGroundingService';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function openAIResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mockPdfGetText.mockResolvedValue({ text: '' });
  mockPdfDestroy.mockResolvedValue(undefined);
});

describe('buildGroundingText', () => {
  it('describes image attachments factually without asking for artistic style', async () => {
    mockFetch.mockResolvedValue(openAIResponse('A volcano releases ash above a mountain.'));

    const result = await buildGroundingText([
      { url: 'https://r2.example.com/volcano.png', mimeType: 'image/png' },
    ], null);

    expect(result).toContain('A volcano releases ash above a mountain.');
    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    const rubric = body.messages[0].content[0].text;
    expect(rubric).toMatch(/factually/i);
    expect(rubric).toMatch(/do not describe artistic style/i);
  });

  it('extracts and bounds PDF text', async () => {
    mockFetch.mockResolvedValue(new Response(Buffer.from('%PDF fake'), { status: 200 }));
    mockPdfGetText.mockResolvedValue({ text: `PDF facts ${'x'.repeat(4_000)}` });

    const result = await buildGroundingText([
      { url: 'https://r2.example.com/source.pdf', mimeType: 'application/pdf' },
    ], null);

    expect(result).toContain('PDF facts');
    expect(result.length).toBeLessThanOrEqual(3_000);
    expect(mockPdfDestroy).toHaveBeenCalled();
  });

  it('fetches a public URL and strips HTML tags', async () => {
    mockFetch.mockResolvedValue(new Response(
      '<html><body><p>Volcanoes form above rising magma.</p></body></html>',
      { status: 200 },
    ));

    const result = await buildGroundingText([], 'https://example.com/volcanoes');

    expect(result).toContain('Volcanoes form above rising magma.');
    expect(result).not.toMatch(/[<>]/);
  });

  it('skips failed pieces and returns an empty string when every piece fails', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('vision down'))
      .mockResolvedValueOnce(new Response(Buffer.from('%PDF fake'), { status: 200 }))
      .mockResolvedValueOnce(new Response('<p>URL facts survive.</p>', { status: 200 }));
    mockPdfGetText.mockResolvedValueOnce({ text: 'PDF facts survive.' });

    const partial = await buildGroundingText([
      { url: 'https://r2.example.com/image.png', mimeType: 'image/png' },
      { url: 'https://r2.example.com/source.pdf', mimeType: 'application/pdf' },
    ], 'https://example.com/source');

    expect(partial).toContain('PDF facts survive.');
    expect(partial).toContain('URL facts survive.');

    mockFetch
      .mockRejectedValueOnce(new Error('vision down'))
      .mockRejectedValueOnce(new Error('pdf down'))
      .mockRejectedValueOnce(new Error('url down'));

    await expect(buildGroundingText([
      { url: 'https://r2.example.com/image.png', mimeType: 'image/png' },
      { url: 'https://r2.example.com/source.pdf', mimeType: 'application/pdf' },
    ], 'https://example.com/source')).resolves.toBe('');
  });

  it('caps the combined result after three attachments and one URL', async () => {
    const largeFact = `fact ${'x'.repeat(1_700)}`;
    mockFetch
      .mockResolvedValueOnce(openAIResponse(largeFact))
      .mockResolvedValueOnce(openAIResponse(largeFact))
      .mockResolvedValueOnce(openAIResponse(largeFact))
      .mockResolvedValueOnce(new Response(`<p>${largeFact}</p>`, { status: 200 }));

    const result = await buildGroundingText([
      { url: 'https://r2.example.com/one.png', mimeType: 'image/png' },
      { url: 'https://r2.example.com/two.png', mimeType: 'image/png' },
      { url: 'https://r2.example.com/three.png', mimeType: 'image/png' },
    ], 'https://example.com/source');

    expect(result.length).toBeLessThanOrEqual(4_000);
  });

  it('returns immediately when no grounding inputs exist', async () => {
    await expect(buildGroundingText([], null)).resolves.toBe('');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('rejects private and metadata IP targets without fetching them', async () => {
    await expect(buildGroundingText([], 'http://169.254.169.254/latest/meta-data')).resolves.toBe('');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('revalidates a redirect target before following it', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: 'http://127.0.0.1/private' },
    }));

    await expect(buildGroundingText([], 'https://example.com/redirect')).resolves.toBe('');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
