const mockExecute = jest.fn();

jest.mock('../../db/client', () => ({
  db: { execute: mockExecute },
}));

jest.mock('../../config', () => ({
  config: { freeCreditBundle: 5 },
}));

const mockQueryDeviceCheckBit = jest.fn();
const mockUpdateDeviceCheckBit = jest.fn();
jest.mock('../../services/deviceCheckService', () => ({
  queryDeviceCheckBit: mockQueryDeviceCheckBit,
  updateDeviceCheckBit: mockUpdateDeviceCheckBit,
}));

const mockUuid = jest.fn();
jest.mock('uuid', () => ({ v4: mockUuid }));

import { grantIfEligible } from '../../services/freeCreditGrantService';

const DB_USER_ID = '00000000-0000-4000-8000-000000000001';
const FIREBASE_UID = 'firebase-uid-1';
const DEVICE_TOKEN = 'base64-device-token';
const QUERY_TRANSACTION_ID = '11111111-1111-4111-8111-111111111111';
const UPDATE_TRANSACTION_ID = '22222222-2222-4222-8222-222222222222';

function sqlText(callIndex: number): string {
  return JSON.stringify(mockExecute.mock.calls[callIndex]?.[0]);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUuid
    .mockReturnValueOnce(QUERY_TRANSACTION_ID)
    .mockReturnValueOnce(UPDATE_TRANSACTION_ID)
    .mockReturnValue(QUERY_TRANSACTION_ID);
});

describe('grantIfEligible', () => {
  it('sets the DeviceCheck bit before atomically granting the configured bundle', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ free_credits_state: 'pending' }] })
      .mockResolvedValueOnce({ rows: [{ id: DB_USER_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: DB_USER_ID }] });
    mockQueryDeviceCheckBit.mockResolvedValue({ bit0: false, bit1: false });
    mockUpdateDeviceCheckBit.mockResolvedValue(undefined);

    await grantIfEligible(DB_USER_ID, FIREBASE_UID, DEVICE_TOKEN);

    expect(mockQueryDeviceCheckBit).toHaveBeenCalledWith(DEVICE_TOKEN, QUERY_TRANSACTION_ID);
    expect(mockUpdateDeviceCheckBit).toHaveBeenCalledWith(DEVICE_TOKEN, UPDATE_TRANSACTION_ID);
    expect(mockQueryDeviceCheckBit.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateDeviceCheckBit.mock.invocationCallOrder[0],
    );
    expect(sqlText(1)).toContain('devicecheck_updated');
    expect(sqlText(2)).toContain('free_grant');
    expect(sqlText(2)).toContain(UPDATE_TRANSACTION_ID);
    expect(sqlText(2)).toContain('granted');
    expect(sqlText(2)).toContain('5');
  });

  it('recovers a reserved grant when Apple already has bit0 set', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ free_credits_state: 'devicecheck_updated' }] })
      .mockResolvedValueOnce({ rows: [{ id: DB_USER_ID }] });
    mockQueryDeviceCheckBit.mockResolvedValue({ bit0: true, bit1: false });

    await grantIfEligible(DB_USER_ID, FIREBASE_UID, DEVICE_TOKEN);

    expect(mockQueryDeviceCheckBit).toHaveBeenCalledWith(DEVICE_TOKEN, QUERY_TRANSACTION_ID);
    expect(mockUpdateDeviceCheckBit).not.toHaveBeenCalled();
    expect(sqlText(1)).toContain('free_grant');
    expect(sqlText(1)).toContain('granted');
  });

  it('marks an unreserved user ineligible when the device was already claimed', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ free_credits_state: 'pending' }] })
      .mockResolvedValueOnce({ rows: [{ id: DB_USER_ID }] });
    mockQueryDeviceCheckBit.mockResolvedValue({ bit0: true, bit1: false });

    await grantIfEligible(DB_USER_ID, FIREBASE_UID, DEVICE_TOKEN);

    expect(mockUpdateDeviceCheckBit).not.toHaveBeenCalled();
    expect(sqlText(1)).toContain('ineligible');
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('retries the Apple update when a reserved grant has not set bit0 yet', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ free_credits_state: 'devicecheck_updated' }] })
      .mockResolvedValueOnce({ rows: [{ id: DB_USER_ID }] });
    mockQueryDeviceCheckBit.mockResolvedValue({ bit0: false, bit1: false });
    mockUpdateDeviceCheckBit.mockResolvedValue(undefined);

    await grantIfEligible(DB_USER_ID, FIREBASE_UID, DEVICE_TOKEN);

    expect(mockUpdateDeviceCheckBit).toHaveBeenCalledWith(DEVICE_TOKEN, UPDATE_TRANSACTION_ID);
    expect(sqlText(1)).toContain('free_grant');
  });
});

describe('terminal-state idempotency', () => {
  it.each(['granted', 'ineligible'] as const)(
    'returns immediately when the user is already %s',
    async (state) => {
      mockExecute.mockResolvedValueOnce({ rows: [{ free_credits_state: state }] });

      await grantIfEligible(DB_USER_ID, FIREBASE_UID, DEVICE_TOKEN);

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockQueryDeviceCheckBit).not.toHaveBeenCalled();
      expect(mockUpdateDeviceCheckBit).not.toHaveBeenCalled();
    },
  );
});

describe('failure recovery', () => {
  it('never writes the ledger when Apple rejects the bit update', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ free_credits_state: 'pending' }] })
      .mockResolvedValueOnce({ rows: [{ id: DB_USER_ID }] });
    mockQueryDeviceCheckBit.mockResolvedValue({ bit0: false, bit1: false });
    mockUpdateDeviceCheckBit.mockRejectedValue(new Error('Apple rejected token'));

    await expect(grantIfEligible(DB_USER_ID, FIREBASE_UID, DEVICE_TOKEN)).rejects.toThrow(
      'Apple rejected token',
    );

    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute.mock.calls.some((_, index) => sqlText(index).includes('free_grant'))).toBe(false);
  });
});
