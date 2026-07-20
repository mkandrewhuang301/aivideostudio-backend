import { ncmecReportQueue } from '../queue/ncmecReportWorker';
import { refundCredits } from './creditService';
import {
  addModerationStrike,
  banUserForModeration,
  markQuarantined,
} from './generationService';
import type { OutputModerationResult } from './hiveService';
import { quarantineGenerationMedia } from './quarantineService';

export interface FlaggedGenerationContext {
  generationId: string;
  r2Key: string;
  userId: string;
  costCredits: number;
}

/** Apply the locked high/low policy without exposing the classification to the client. */
export async function enforceFlaggedGeneration(
  context: FlaggedGenerationContext,
  result: OutputModerationResult,
): Promise<void> {
  // Old test/mocked callers may supply only { flagged: true }; defaulting that to LOW preserves
  // the safer non-reporting lane rather than accidentally filing a high-confidence report.
  const tier = result.tier === 'high' ? 'high' : 'low';
  let quarantineKey = context.r2Key;
  try {
    quarantineKey = await quarantineGenerationMedia(context.generationId, context.r2Key);
  } catch (error) {
    // The status transition still makes the original key unreachable to clients. Keeping the
    // source object is also safer than deleting the only reportable artifact after a failed copy.
    console.error(`[moderation] Failed to move ${context.generationId} under quarantine/; preserving original key:`, error);
  }
  await markQuarantined(context.generationId, quarantineKey);

  if (tier === 'high') {
    await banUserForModeration(context.userId);
    await ncmecReportQueue.add(
      'report',
      { generationId: context.generationId },
      { jobId: `ncmec-${context.generationId}` },
    );
    console.warn(`[moderation] High-confidence automated enforcement completed for ${context.generationId}`);
    return;
  }

  await refundCredits(
    context.userId,
    context.costCredits,
    `moderation-quarantine-${context.generationId}`,
  );
  const strike = await addModerationStrike(context.userId);
  console.warn(
    `[moderation] Low-confidence automated enforcement completed for ${context.generationId}; strike=${strike.strikes}, banned=${strike.banned}`,
  );
}
