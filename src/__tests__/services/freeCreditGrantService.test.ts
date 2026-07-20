// Wave 0 scaffold for the DeviceCheck-backed free-credit grant service.
// Plan 18-02 replaces these TODOs with behavior assertions.

export {};

const mockExecute = jest.fn();
const mockInsertValues = jest.fn();
const mockInsert = jest.fn(() => ({ values: mockInsertValues }));
const mockUpdateSet = jest.fn();
const mockUpdate = jest.fn(() => ({ set: mockUpdateSet }));

jest.mock('../../config', () => ({
  config: {
    freeCreditBundle: 5,
    deviceCheckPrivateKey: 'key',
    deviceCheckKeyId: 'kid',
    deviceCheckTeamId: 'tid',
  },
}));

jest.mock('../../db/client', () => ({
  db: {
    execute: mockExecute,
    insert: mockInsert,
    update: mockUpdate,
  },
}));

const mockSign = jest.fn();
jest.mock('jsonwebtoken', () => ({ sign: mockSign }), { virtual: true });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('grantIfEligible', () => {
  it.todo('grants free credits on first eligible request');
  it.todo('persists devicecheck_updated before writing the free_grant ledger row');
  it.todo('marks the user granted after the atomic balance and ledger write');
});

describe('DeviceCheck unavailable fallback', () => {
  it.todo('leaves the grant pending when DeviceCheck credentials are unavailable');
  it.todo('does not write credits when Apple rejects the device token');
  it.todo('marks the user ineligible when the device bit is already set');
});

describe('idempotency', () => {
  it.todo('does not grant twice for the same Firebase user');
  it.todo('recovers a ledger write after DeviceCheck was updated');
  it.todo('does not update Apple after the user reaches a terminal state');
});
