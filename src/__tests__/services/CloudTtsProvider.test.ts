jest.mock('../../config', () => ({
  config: {
    cloudTtsEnabled: true,
    cloudTtsApiKey: '',
    cloudTtsVoice: 'en-US-Chirp3-HD-Kore',
  },
}));

const mockGetAccessToken = jest.fn();
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({ getAccessToken: mockGetAccessToken })),
}));

import { cloudTtsSynthesize, resolveCloudTtsVoice, CloudTtsError } from '../../services/providers/CloudTtsProvider';
import { config } from '../../config';

function riffWavBase64(): string {
  const b = Buffer.alloc(64);
  b.write('RIFF', 0, 'ascii');
  b.write('WAVE', 8, 'ascii');
  return b.toString('base64');
}

describe('resolveCloudTtsVoice', () => {
  it('maps a bare Gemini voice name onto the configured Chirp3-HD locale', () => {
    expect(resolveCloudTtsVoice('Kore')).toEqual({ languageCode: 'en-US', name: 'en-US-Chirp3-HD-Kore' });
    expect(resolveCloudTtsVoice('Puck')).toEqual({ languageCode: 'en-US', name: 'en-US-Chirp3-HD-Puck' });
  });

  it('passes a fully-qualified voice name through verbatim, keeping its own locale', () => {
    expect(resolveCloudTtsVoice('de-DE-Chirp3-HD-Zephyr'))
      .toEqual({ languageCode: 'de-DE', name: 'de-DE-Chirp3-HD-Zephyr' });
  });

  it('defaults an empty name to the configured voice', () => {
    expect(resolveCloudTtsVoice('')).toEqual({ languageCode: 'en-US', name: 'en-US-Chirp3-HD-Kore' });
  });
});

describe('cloudTtsSynthesize', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    jest.clearAllMocks();
    (config as { cloudTtsApiKey: string }).cloudTtsApiKey = '';
    mockGetAccessToken.mockResolvedValue('adc-token-xyz');
    fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ audioContent: riffWavBase64() }) });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  it('returns the decoded WAV and sends the mapped voice + clamped speakingRate', async () => {
    const wav = await cloudTtsSynthesize('Hello world.', 'Kore', 1.25);

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
    const body = JSON.parse(init.body);
    expect(body.voice).toEqual({ languageCode: 'en-US', name: 'en-US-Chirp3-HD-Kore' });
    expect(body.input.text).toBe('Hello world.');
    expect(body.audioConfig.audioEncoding).toBe('LINEAR16');
    expect(body.audioConfig.speakingRate).toBe(1.25);
  });

  it('uses ADC bearer auth when no API key is configured, and never a key query param', async () => {
    await cloudTtsSynthesize('Hi.', 'Kore');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('key=');
    expect(init.headers.Authorization).toBe('Bearer adc-token-xyz');
    expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
  });

  it('prefers the API key when set, and never mints an ADC token', async () => {
    (config as { cloudTtsApiKey: string }).cloudTtsApiKey = 'AIzaTESTKEY';
    await cloudTtsSynthesize('Hi.', 'Kore');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('key=AIzaTESTKEY');
    expect(init.headers.Authorization).toBeUndefined();
    expect(mockGetAccessToken).not.toHaveBeenCalled();
  });

  it('raises a status-carrying error on a non-200, surfacing Google\'s message but no secret', async () => {
    (config as { cloudTtsApiKey: string }).cloudTtsApiKey = 'AIzaSECRET';
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { message: 'Quota exceeded' } }) });

    const err = await cloudTtsSynthesize('Hi.', 'Kore').catch((e) => e);
    expect(err).toBeInstanceOf(CloudTtsError);
    expect(err.status).toBe(429);
    expect(err.message).toContain('Quota exceeded');
    expect(err.message).not.toContain('AIzaSECRET');
  });

  it('rejects an empty audio payload', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(cloudTtsSynthesize('Hi.', 'Kore')).rejects.toThrow(/no audioContent/);
  });
});
