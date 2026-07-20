// Wave 0 scaffold for anonymous-to-existing-account merge behavior.
// Plan 18-03 replaces these TODOs with transaction and ledger assertions.

export {};

const mockBatch = jest.fn();
const mockExecute = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = jest.fn(() => ({ set: mockUpdateSet }));
const mockInsertValues = jest.fn();
const mockInsert = jest.fn(() => ({ values: mockInsertValues }));

jest.mock('../../config', () => ({ config: {} }));

jest.mock('../../db/client', () => ({
  db: {
    batch: mockBatch,
    update: mockUpdate,
    insert: mockInsert,
    execute: mockExecute,
  },
}));

const mockDeleteUser = jest.fn();
jest.mock('../../firebase', () => ({
  getFirebaseAdmin: () => ({ auth: { deleteUser: mockDeleteUser } }),
}));

const mockEvictAuthCache = jest.fn();
jest.mock('../../middleware/auth', () => ({
  evictAuthCache: mockEvictAuthCache,
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('mergeUser', () => {
  it.todo('moves purchased credits and owned resources to the target user');
  it.todo('copies an entitlement only when the target has none');
  it.todo('deletes the anonymous Firebase user after the database batch commits');
});

describe('free-grant exclusion', () => {
  it.todo('moves purchased credits and excludes free_grant rows');
  it.todo('records excluded free credits in the user_merges audit row');
  it.todo('never increases the target balance by unspent free credits');
});

describe('idempotency', () => {
  it.todo('returns the prior result for an already-recorded merge');
  it.todo('does not run a second transfer batch for the same user pair');
  it.todo('evicts auth cache entries for both Firebase UIDs');
});
