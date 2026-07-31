/**
 * Webhook signer — HMAC-SHA256 signing for outbound webhooks to Scentic.
 *
 * Security:
 * - Signature covers: body + timestamp + nonce + eventId + firmId + correlationId
 * - Constant-time comparison is used by the receiver (Scentic side)
 * - Secrets are never logged
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { WebhookPayload, WebhookHeaders } from './webhook-types.js';

export function signWebhook(
  secret: string,
  body: string,
  timestamp: string,
  nonce: string,
  eventId: string,
  firmId: string,
  correlationId: string,
): string {
  const canonicalString = [
    body,
    timestamp,
    nonce,
    eventId,
    firmId,
    correlationId,
  ].join('\n');

  return createHmac('sha256', secret).update(canonicalString).digest('hex');
}

export function createWebhookHeaders(
  secret: string,
  payload: WebhookPayload,
): { headers: WebhookHeaders; body: string } {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const nonce = randomUUID();

  const signature = signWebhook(
    secret,
    body,
    timestamp,
    nonce,
    payload.eventId,
    payload.scenticFirmId,
    payload.correlationId,
  );

  return {
    headers: {
      'X-Gateway-Signature': `sha256=${signature}`,
      'X-Gateway-Timestamp': timestamp,
      'X-Gateway-Nonce': nonce,
      'X-Gateway-Event-Id': payload.eventId,
      'X-Gateway-Firm-Id': payload.scenticFirmId,
      'X-Gateway-Correlation-Id': payload.correlationId,
      'Idempotency-Key': payload.idempotencyKey,
      'Content-Type': 'application/json',
    },
    body,
  };
}

/**
 * Verify a webhook signature (for testing or relay scenarios).
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  timestamp: string,
  nonce: string,
  eventId: string,
  firmId: string,
  correlationId: string,
  providedSignature: string,
): boolean {
  if (!providedSignature) return false;
  const expected = signWebhook(secret, body, timestamp, nonce, eventId, firmId, correlationId);
  // Strip "sha256=" prefix if present
  const provided = providedSignature.startsWith('sha256=') ? providedSignature.slice(7) : providedSignature;
  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}
