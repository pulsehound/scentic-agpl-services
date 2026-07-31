/**
 * HMAC signature utilities for service-to-service auth.
 *
 * Security invariants:
 * - Constant-time comparison via timingSafeEqual
 * - Signature covers method, path, query, timestamp, nonce, body hash, firm ID, user ID, correlation ID
 * - Timestamp tolerance enforced
 * - Nonce replay protection (in-memory for dev, Redis for production)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignaturePayload {
  method: string;
  path: string;
  queryString: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
  firmId: string;
  userId?: string;
  correlationId?: string;
}

export function computeBodyHash(body: string | Buffer | undefined): string {
  if (!body) return '';
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  return createHmac('sha256', '').update(buf).digest('hex');
}

export function computeSignature(secret: string, payload: SignaturePayload): string {
  const canonicalString = [
    payload.method.toUpperCase(),
    payload.path,
    payload.queryString || '',
    payload.timestamp,
    payload.nonce,
    payload.bodyHash,
    payload.firmId,
    payload.userId || '',
    payload.correlationId || '',
  ].join('\n');

  return createHmac('sha256', secret).update(canonicalString).digest('hex');
}

export function verifySignature(
  secret: string,
  payload: SignaturePayload,
  providedSignature: string,
): boolean {
  if (!providedSignature) return false;
  const expected = computeSignature(secret, payload);
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(providedSignature, 'hex');

  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export interface NonceStore {
  seen(nonce: string, timestamp: number): Promise<boolean>;
  clear(): Promise<void>;
}

export class InMemoryNonceStore implements NonceStore {
  private nonces = new Map<string, number>();
  private maxAgeMs: number;

  constructor(maxAgeMs: number = 300_000) {
    this.maxAgeMs = maxAgeMs;
  }

  async seen(nonce: string, timestamp: number): Promise<boolean> {
    // Clean expired nonces
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [key, ts] of this.nonces) {
      if (ts < cutoff) this.nonces.delete(key);
    }

    if (this.nonces.has(nonce)) return true;
    this.nonces.set(nonce, timestamp);
    return false;
  }

  async clear(): Promise<void> {
    this.nonces.clear();
  }
}

export const TIMESTAMP_TOLERANCE_MS = 300_000; // 5 minutes

export function isTimestampValid(timestamp: string, toleranceMs: number = TIMESTAMP_TOLERANCE_MS): boolean {
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const now = Date.now();
  return Math.abs(now - ts) <= toleranceMs;
}
