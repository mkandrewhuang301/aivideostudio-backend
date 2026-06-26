// src/__tests__/services/apnsService.test.ts
// Unit tests for apnsService — verifies @parse/node-apn usage, isolated error handling
// (push failures must never throw past the caller), and singleton Provider construction.

jest.mock('../../config', () => ({
  config: {
    apnsAuthKey: 'fake-p8-key',
    apnsKeyId: 'FAKEKEYID',
    apnsTeamId: 'FAKETEAMID',
    apnsBundleId: 'com.fantasiaai.app',
    nodeEnv: 'production',
  },
}));

const mockSend = jest.fn();
const providerConstructorCalls: unknown[] = [];

class MockProvider {
  send: jest.Mock;
  constructor(options: unknown) {
    providerConstructorCalls.push(options);
    this.send = mockSend;
  }
}

class MockNotification {
  alert?: string;
  payload?: Record<string, unknown>;
  topic?: string;
}

jest.mock('@parse/node-apn', () => ({
  __esModule: true,
  default: {
    Provider: MockProvider,
    Notification: MockNotification,
  },
}));

import { sendGenerationComplete } from '../../services/apnsService';

describe('apnsService', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('constructs a notification with topic and payload, then calls Provider.send', async () => {
    mockSend.mockResolvedValue(undefined);

    await sendGenerationComplete('device-token-123', 'gen-abc');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [notification, deviceToken] = mockSend.mock.calls[0];
    expect(deviceToken).toBe('device-token-123');
    expect(notification.topic).toBe('com.fantasiaai.app');
    expect(notification.payload).toEqual({ generationId: 'gen-abc' });
  });

  it('does not throw when Provider.send rejects (expired/invalid device token)', async () => {
    mockSend.mockRejectedValue(new Error('BadDeviceToken'));

    await expect(sendGenerationComplete('stale-token', 'gen-xyz')).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('constructs apn.Provider exactly once at module load with token config and production flag', () => {
    // apnProvider is a module-level singleton constructed once at import time (see action above).
    // Repeated calls to sendGenerationComplete (tests above) must not re-construct the Provider.
    expect(providerConstructorCalls).toHaveLength(1);
    expect(providerConstructorCalls[0]).toEqual({
      token: {
        key: 'fake-p8-key',
        keyId: 'FAKEKEYID',
        teamId: 'FAKETEAMID',
      },
      production: true,
    });
  });
});
