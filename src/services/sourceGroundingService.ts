import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PDFParse } from 'pdf-parse';
import { config } from '../config';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_ATTACHMENTS = 3;
const MAX_PIECE_CHARS = 3_000;
const MAX_COMBINED_CHARS = 4_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 30_000;
const PDF_TIMEOUT_MS = 30_000;
const SOURCE_TIMEOUT_MS = 15_000;

export interface GroundingAttachment {
  /** Presigned URL resolved by the caller from an IDOR-checked, user-owned upload id. */
  url: string;
  mimeType: string;
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('response exceeds size limit');
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('response exceeds size limit');
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error('response exceeds size limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 168);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family !== 6) return true;

  if (normalized.startsWith('::ffff:')) {
    return isPrivateIpv4(normalized.slice('::ffff:'.length));
  }
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized);
}

async function validatePublicUrl(value: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return isPrivateAddress(hostname) ? null : url;

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
      return null;
    }
  } catch {
    return null;
  }
  return url;
}

async function describeImageFactually(url: string): Promise<string> {
  const response = await fetchWithTimeout(OPENAI_CHAT_COMPLETIONS_URL, IMAGE_TIMEOUT_MS, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe this image factually in 1-2 plain sentences for use as research background. Do NOT describe artistic style, color palette, or composition — facts/content only.',
          },
          { type: 'image_url', image_url: { url } },
        ],
      }],
      max_tokens: 180,
      temperature: 0,
    }),
  });
  if (!response.ok) throw new Error(`image grounding failed (${response.status})`);

  const data = (await response.json()) as OpenAIChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('image grounding returned no content');
  return content.slice(0, MAX_PIECE_CHARS);
}

async function extractPdfText(url: string): Promise<string> {
  const response = await fetchWithTimeout(url, PDF_TIMEOUT_MS);
  if (!response.ok) throw new Error(`PDF download failed (${response.status})`);
  const buffer = await readBoundedBuffer(response, MAX_PDF_BYTES);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text.replace(/\s+/g, ' ').trim().slice(0, MAX_PIECE_CHARS);
  } finally {
    await parser.destroy();
  }
}

async function extractSourceUrlText(sourceUrl: string): Promise<string> {
  let currentUrl = await validatePublicUrl(sourceUrl);
  if (!currentUrl) return '';

  for (let redirectCount = 0; redirectCount <= 1; redirectCount += 1) {
    const response = await fetchWithTimeout(currentUrl.toString(), SOURCE_TIMEOUT_MS, {
      redirect: 'manual',
      headers: { Accept: 'text/html,text/plain;q=0.9' },
    });
    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= 1) return '';
      const location = response.headers.get('location');
      if (!location) return '';
      currentUrl = await validatePublicUrl(new URL(location, currentUrl).toString());
      if (!currentUrl) return '';
      continue;
    }
    if (!response.ok) return '';

    const buffer = await readBoundedBuffer(response, MAX_SOURCE_BYTES);
    return buffer
      .toString('utf8')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PIECE_CHARS);
  }
  return '';
}

/**
 * Converts user-owned attachments and one SSRF-guarded source URL into a bounded factual blob.
 * Every piece is a soft signal: failures are skipped and this function never rejects.
 */
export async function buildGroundingText(
  attachments: GroundingAttachment[],
  sourceUrl: string | null,
): Promise<string> {
  if (attachments.length === 0 && !sourceUrl) return '';

  const pieces: string[] = [];
  for (const attachment of attachments.slice(0, MAX_ATTACHMENTS)) {
    try {
      let text = '';
      if (attachment.mimeType.startsWith('image/')) {
        text = await describeImageFactually(attachment.url);
      } else if (attachment.mimeType === 'application/pdf') {
        text = await extractPdfText(attachment.url);
      }
      if (text) pieces.push(text);
    } catch {
      console.warn('[sourceGroundingService] Skipping failed attachment grounding piece');
    }
  }

  if (sourceUrl) {
    try {
      const text = await extractSourceUrlText(sourceUrl);
      if (text) pieces.push(text);
    } catch {
      console.warn('[sourceGroundingService] Skipping failed URL grounding piece');
    }
  }

  return pieces.join('\n\n').slice(0, MAX_COMBINED_CHARS);
}
