import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';

const DEVICE_CHECK_API_BASE = 'https://api.devicecheck.apple.com/v1';
const DEVICE_CHECK_JWT_TTL_SECONDS = 300;

interface DeviceCheckQueryResponse {
  bit0: boolean;
  bit1: boolean;
  last_update_time?: string;
}

export interface DeviceCheckBits {
  bit0: boolean;
  bit1: boolean;
  lastUpdateTime?: string;
}

function createAuthorizationToken(): string {
  const privateKey = config.deviceCheckPrivateKey.trim();
  const keyId = config.deviceCheckKeyId.trim();
  const teamId = config.deviceCheckTeamId.trim();

  if (!privateKey || !keyId || !teamId) {
    throw new Error(
      'Apple DeviceCheck is not configured: DEVICE_CHECK_PRIVATE_KEY, DEVICE_CHECK_KEY_ID, and DEVICE_CHECK_TEAM_ID are required',
    );
  }

  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: teamId,
      iat: now,
      exp: now + DEVICE_CHECK_JWT_TTL_SECONDS,
    },
    privateKey,
    {
      algorithm: 'ES256',
      header: { kid: keyId, alg: 'ES256' },
    },
  );
}

async function postToDeviceCheck<T>(
  path: 'query_two_bits' | 'update_two_bits',
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${DEVICE_CHECK_API_BASE}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${createAuthorizationToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Apple DeviceCheck ${path} failed (${response.status}): ${errorBody || response.statusText}`,
    );
  }

  // Apple's update_two_bits endpoint reports success with HTTP 200 and no JSON body.
  // Only query_two_bits has a response payload; trying to decode update success as JSON
  // turns a completed Apple bit update into a false grant failure.
  if (path === 'update_two_bits' || response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function queryDeviceCheckBit(
  deviceToken: string,
  transactionId: string = uuidv4(),
): Promise<DeviceCheckBits> {
  const response = await postToDeviceCheck<DeviceCheckQueryResponse>('query_two_bits', {
    device_token: deviceToken,
    transaction_id: transactionId,
    timestamp: Date.now(),
  });

  return {
    bit0: response.bit0,
    bit1: response.bit1,
    ...(response.last_update_time ? { lastUpdateTime: response.last_update_time } : {}),
  };
}

export async function updateDeviceCheckBit(
  deviceToken: string,
  transactionId: string = uuidv4(),
): Promise<void> {
  await postToDeviceCheck<void>('update_two_bits', {
    device_token: deviceToken,
    transaction_id: transactionId,
    timestamp: Date.now(),
    bit0: true,
    bit1: false,
  });
}
