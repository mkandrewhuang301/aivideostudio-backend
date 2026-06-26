// src/services/apnsService.ts
// APNs push notifications via @parse/node-apn (maintained fork — NOT the unmaintained `apn` package,
// confirmed stale since 2022 per RESEARCH.md). p8 token-based auth, per CLAUDE.md "Push: APNs direct".
// RESEARCH.md Pitfall 5: push failures must NEVER block webhook completion — always isolated here.

import apn from '@parse/node-apn';
import { config } from '../config';

const apnProvider = new apn.Provider({
  token: {
    key: config.apnsAuthKey,
    keyId: config.apnsKeyId,
    teamId: config.apnsTeamId,
  },
  production: config.nodeEnv === 'production',
});

/**
 * Sends a "generation complete" push notification. Never throws — a push failure
 * (expired token, network error) must not block the caller's webhook completion logic.
 */
export async function sendGenerationComplete(deviceToken: string, generationId: string): Promise<void> {
  try {
    const notification = new apn.Notification();
    notification.alert = 'Your video is ready!';
    notification.payload = { generationId };
    notification.topic = config.apnsBundleId;
    await apnProvider.send(notification, deviceToken);
  } catch (error) {
    console.error('[apnsService] Failed to send push notification:', error);
  }
}
