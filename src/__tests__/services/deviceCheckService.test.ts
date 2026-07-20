const mockFetch = jest.fn();
const mockJwtSign = jest.fn(() => 'signed-devicecheck-jwt');

global.fetch = mockFetch as unknown as typeof fetch;

jest.mock('jsonwebtoken', () => ({
  __esModule: true,
  default: { sign: mockJwtSign },
}));

jest.mock('uuid', () => ({ v4: () => 'generated-transaction-id' }));

jest.mock('../../config', () => ({
  config: {
    deviceCheckPrivateKey: 'test-private-key',
    deviceCheckKeyId: 'TESTKEY123',
    deviceCheckTeamId: 'TESTTEAM12',
  },
}));

import { queryDeviceCheckBit, updateDeviceCheckBit } from '../../services/deviceCheckService';

describe('deviceCheckService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('decodes a successful query_two_bits response', async () => {
    const json = jest.fn().mockResolvedValue({
      bit0: true,
      bit1: false,
      last_update_time: '2026-07',
    });
    mockFetch.mockResolvedValue({ ok: true, status: 200, json });

    await expect(queryDeviceCheckBit('base64-device-token', 'query-transaction-id')).resolves.toEqual({
      bit0: true,
      bit1: false,
      lastUpdateTime: '2026-07',
    });
    expect(json).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.devicecheck.apple.com/v1/query_two_bits',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer signed-devicecheck-jwt' }),
      }),
    );
  });

  it('accepts Apple update_two_bits HTTP 200 with an empty response body', async () => {
    const json = jest.fn().mockRejectedValue(new SyntaxError('Unexpected end of JSON input'));
    mockFetch.mockResolvedValue({ ok: true, status: 200, json });

    await expect(
      updateDeviceCheckBit('base64-device-token', 'update-transaction-id'),
    ).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('surfaces Apple error status and body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: jest.fn().mockResolvedValue('Bad Device Token'),
    });

    await expect(queryDeviceCheckBit('bad-token', 'query-transaction-id')).rejects.toThrow(
      'Apple DeviceCheck query_two_bits failed (400): Bad Device Token',
    );
  });
});
