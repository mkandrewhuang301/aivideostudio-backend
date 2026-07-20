import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
} from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../storage/r2';

const RULE_ID = 'fantasia-quarantine-365-days';

async function existingRules(): Promise<LifecycleRule[]> {
  try {
    const response = await r2.send(new GetBucketLifecycleConfigurationCommand({
      Bucket: R2_BUCKET,
    }));
    return response.Rules ?? [];
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status === 404 || name === 'NoSuchLifecycleConfiguration') return [];
    throw error;
  }
}

async function main(): Promise<void> {
  const rules = (await existingRules()).filter((rule) => rule.ID !== RULE_ID);
  rules.push({
    ID: RULE_ID,
    Status: 'Enabled',
    Filter: { Prefix: 'quarantine/' },
    Expiration: { Days: 365 },
  });

  await r2.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: R2_BUCKET,
    LifecycleConfiguration: { Rules: rules },
  }));
  console.log(`[r2-lifecycle] ${R2_BUCKET}: quarantine/ objects expire after 365 days`);
}

main().catch((error) => {
  console.error('[r2-lifecycle] Failed to configure quarantine retention:', error);
  process.exitCode = 1;
});
