// src/services/falWebhookVerify.ts
// Fal.ai webhook signature verification — ED25519 + JWKS, a completely different scheme from
// Replicate's shared-secret HMAC (validateWebhook() from the `replicate` package). Live-verified
// 2026-07-15 against https://fal.ai/docs/model-apis/model-endpoints/webhooks:
//   Headers: X-Fal-Webhook-Request-Id, X-Fal-Webhook-User-Id, X-Fal-Webhook-Timestamp (unix
//   seconds), X-Fal-Webhook-Signature (hex-encoded).
//   Message to verify = requestId + "\n" + userId + "\n" + timestamp + "\n" + sha256(rawBody)-hex.
//   Public keys fetched from https://rest.fal.ai/.well-known/jwks.json (JWK, kty=OKP/crv=Ed25519),
//   cacheable 24h. Timestamp must be within +/-5 minutes of now (replay protection).
//
// Uses Node's built-in crypto (Ed25519 JWK import + verify have been native since Node 15.9) —
// deliberately NOT the `libsodium-wrappers` dependency Fal's own doc example uses, since this
// project avoids adding a dependency for something the runtime already does natively.

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

const JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json';
const JWKS_CACHE_MS = 24 * 60 * 60 * 1000;
const TIMESTAMP_TOLERANCE_SECONDS = 300;

interface Jwk {
  kty: string;
  crv: string;
  x: string;
}

let jwksCache: Jwk[] | null = null;
let jwksCacheAt = 0;

async function fetchJwks(): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCacheAt < JWKS_CACHE_MS) return jwksCache;
  const response = await fetch(JWKS_URL);
  if (!response.ok) throw new Error(`Fal JWKS fetch failed: ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  jwksCache = body.keys ?? [];
  jwksCacheAt = Date.now();
  return jwksCache;
}

export interface FalWebhookHeaders {
  requestId: string;
  userId: string;
  timestamp: string;
  signature: string;
}

export async function verifyFalWebhookSignature(
  headers: FalWebhookHeaders,
  rawBody: Buffer,
): Promise<boolean> {
  const timestampInt = parseInt(headers.timestamp, 10);
  if (!Number.isFinite(timestampInt)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampInt) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const bodyHashHex = createHash('sha256').update(rawBody).digest('hex');
  const message = Buffer.from(
    [headers.requestId, headers.userId, headers.timestamp, bodyHashHex].join('\n'),
    'utf-8',
  );

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(headers.signature, 'hex');
  } catch {
    return false;
  }

  const keys = await fetchJwks();
  for (const jwk of keys) {
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') continue;
    try {
      const publicKey = createPublicKey({ key: jwk, format: 'jwk' } as Parameters<typeof createPublicKey>[0]);
      if (cryptoVerify(null, message, publicKey, signatureBytes)) return true;
    } catch {
      continue;
    }
  }
  return false;
}
