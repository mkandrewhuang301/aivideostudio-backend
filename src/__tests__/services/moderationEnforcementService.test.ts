const mockReportAdd = jest.fn();
jest.mock('../../queue/ncmecReportWorker', () => ({
  ncmecReportQueue: { add: mockReportAdd },
}));

jest.mock('../../services/creditService', () => ({ refundCredits: jest.fn() }));
jest.mock('../../services/generationService', () => ({
  addModerationStrike: jest.fn(),
  banUserForModeration: jest.fn(),
  markQuarantined: jest.fn(),
}));
jest.mock('../../services/quarantineService', () => ({
  quarantineGenerationMedia: jest.fn(),
}));

import { refundCredits } from '../../services/creditService';
import {
  addModerationStrike,
  banUserForModeration,
  markQuarantined,
} from '../../services/generationService';
import { enforceFlaggedGeneration } from '../../services/moderationEnforcementService';
import { quarantineGenerationMedia } from '../../services/quarantineService';

const CONTEXT = {
  generationId: '11111111-1111-4111-8111-111111111111',
  r2Key: 'generations/flagged.mp4',
  userId: '22222222-2222-4222-8222-222222222222',
  costCredits: 45,
};

beforeEach(() => {
  jest.clearAllMocks();
  (quarantineGenerationMedia as jest.Mock).mockResolvedValue(
    `quarantine/${CONTEXT.generationId}/flagged.mp4`,
  );
  (markQuarantined as jest.Mock).mockResolvedValue(true);
  (addModerationStrike as jest.Mock).mockResolvedValue({ strikes: 1, banned: false });
  mockReportAdd.mockResolvedValue(undefined);
});

it('high tier quarantines, bans, and enqueues one idempotent CyberTipline report without refunding', async () => {
  await enforceFlaggedGeneration(CONTEXT, {
    flagged: true,
    tier: 'high',
    reason: 'csam_classifier',
    childScore: 0.95,
    sexualScore: 0.9,
    hashMatched: false,
  });

  expect(markQuarantined).toHaveBeenCalledWith(
    CONTEXT.generationId,
    `quarantine/${CONTEXT.generationId}/flagged.mp4`,
  );
  expect(banUserForModeration).toHaveBeenCalledWith(CONTEXT.userId);
  expect(mockReportAdd).toHaveBeenCalledWith(
    'report',
    { generationId: CONTEXT.generationId },
    { jobId: `ncmec-${CONTEXT.generationId}` },
  );
  expect(refundCredits).not.toHaveBeenCalled();
  expect(addModerationStrike).not.toHaveBeenCalled();
});

it('low tier quarantines, refunds idempotently, and adds a strike without reporting', async () => {
  await enforceFlaggedGeneration(CONTEXT, {
    flagged: true,
    tier: 'low',
    reason: 'sexual_content',
    childScore: 0.81,
    sexualScore: 0.72,
    hashMatched: false,
  });

  expect(refundCredits).toHaveBeenCalledWith(
    CONTEXT.userId,
    CONTEXT.costCredits,
    `moderation-quarantine-${CONTEXT.generationId}`,
  );
  expect(addModerationStrike).toHaveBeenCalledWith(CONTEXT.userId);
  expect(banUserForModeration).not.toHaveBeenCalled();
  expect(mockReportAdd).not.toHaveBeenCalled();
});

it('preserves the original R2 key if the copy to quarantine fails', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  (quarantineGenerationMedia as jest.Mock).mockRejectedValue(new Error('R2 copy failed'));

  await enforceFlaggedGeneration(CONTEXT, {
    flagged: true,
    tier: 'low',
    childScore: 0.8,
    sexualScore: 0.7,
    hashMatched: false,
  });

  expect(markQuarantined).toHaveBeenCalledWith(CONTEXT.generationId, CONTEXT.r2Key);
  errorSpy.mockRestore();
});
