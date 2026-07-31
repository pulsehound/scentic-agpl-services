/**
 * Webhook types — outbound event dispatch to Scentic-compatible target.
 */

export type WebhookEventStatus =
  | 'PENDING'
  | 'DISPATCHING'
  | 'DELIVERED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL';

export interface WebhookPayload {
  eventType: string;
  eventVersion: number;
  eventId: string;
  scenticFirmId: string;
  scenticUserId?: string;
  scenticMatterId?: string;
  scenticDocumentId?: string;
  scenticDocumentVersionId?: string;
  scenticPhysicalFileId?: string;
  scenticSignatureWorkflowId?: string;
  externalProvider: 'kimai' | 'opensign';
  externalObjectRef?: string;
  safeSummary: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export interface WebhookHeaders {
  'X-Gateway-Signature': string;
  'X-Gateway-Timestamp': string;
  'X-Gateway-Nonce': string;
  'X-Gateway-Event-Id': string;
  'X-Gateway-Firm-Id': string;
  'X-Gateway-Correlation-Id': string;
  'Idempotency-Key': string;
  'Content-Type': string;
}

export interface WebhookDispatchResult {
  eventId: string;
  status: WebhookEventStatus;
  httpStatus?: number;
  attempt: number;
  nextRetryAt?: string;
  error?: string;
}

export interface WebhookDispatcherConfig {
  targetUrl: string;
  hmacSecret: string;
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  timeoutMs: number;
  enabled: boolean;
}
