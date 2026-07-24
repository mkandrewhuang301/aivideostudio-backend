import { GoogleAuth } from 'google-auth-library';
import { config } from '../../config';
import type {
  MusicGenerationInput,
  MusicGenerationProvider,
  MusicGenerationResult,
} from './MusicGenerationProvider';

const MAX_AUDIO_BYTES = 48 * 1024 * 1024;
const TIMEOUT_MS = 4 * 60_000;

export class MusicProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(message);
  }
}

let auth: GoogleAuth | undefined;

async function accessToken(): Promise<string> {
  if (!config.agentPlatformClientEmail || !config.agentPlatformPrivateKey) {
    throw new MusicProviderError('Music provider is not configured', false, 'not_configured');
  }
  auth ??= new GoogleAuth({
    credentials: {
      client_email: config.agentPlatformClientEmail,
      private_key: config.agentPlatformPrivateKey,
    },
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const token = await auth.getAccessToken();
  if (!token) throw new MusicProviderError('Music provider token unavailable', true, 'auth_unavailable');
  return token;
}

function findAudio(node: unknown, seen = new Set<object>()): { data: string; mimeType: string } | undefined {
  if (!node || typeof node !== 'object' || seen.has(node as object)) return undefined;
  seen.add(node as object);
  const value = node as Record<string, unknown>;
  const mime = value.mime_type ?? value.mimeType;
  if (typeof value.data === 'string' && value.data.length > 0 && mime === 'audio/mpeg') {
    return { data: value.data, mimeType: mime };
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findAudio(item, seen);
        if (found) return found;
      }
    } else {
      const found = findAudio(child, seen);
      if (found) return found;
    }
  }
  return undefined;
}

export class LyriaMusicProvider implements MusicGenerationProvider {
  async generate(input: MusicGenerationInput): Promise<MusicGenerationResult> {
    const token = await accessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(
        `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(config.agentPlatformProjectId)}/locations/global/interactions`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: input.model,
            input: [
              { type: 'text', text: input.prompt },
              ...input.referenceImages.slice(0, 10).map((image) => ({
                type: 'image',
                mime_type: image.mimeType,
                data: image.data.toString('base64'),
              })),
            ],
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const code = response.status === 429 ? 'rate_limited' : response.status === 400 ? 'safety_rejected' : 'provider_error';
        throw new MusicProviderError(`Lyria request failed (${response.status})`, retryable, code);
      }
      const payload: unknown = await response.json();
      const block = findAudio(payload);
      if (!block) throw new MusicProviderError('Lyria returned no audio', false, 'invalid_output');
      const audio = Buffer.from(block.data, 'base64');
      if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) {
        throw new MusicProviderError('Lyria returned invalid audio', false, 'invalid_output');
      }
      const id = payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string'
        ? (payload as { id: string }).id
        : undefined;
      return { audio, mimeType: 'audio/mpeg', providerRequestId: id };
    } catch (error) {
      if (error instanceof MusicProviderError) throw error;
      throw new MusicProviderError('Lyria request failed', true, 'provider_error');
    } finally {
      clearTimeout(timeout);
    }
  }
}
