/**
 * Webhook dispatcher — dispatches outbox events to a Scentic-compatible callback target.
 *
 * Features:
 * - HMAC-SHA256 signed payloads
 * - Retry with exponential backoff
 * - Idempotency key per event
 * - Safe failure when target is down
 * - Dispatch disabled when target URL not configured
 * - No document contents, signing links, or raw signer emails in payloads
 * - Event status tracked: PENDING → DISPATCHING → DELIVERED / FAILED_RETRYABLE / FAILED_FINAL
 */

import { randomUUID } from 'node:crypto';
import type { OutboxEvent, EventOutbox } from './outbox.js';
import type { WebhookPayload, WebhookDispatchResult, WebhookEventStatus, WebhookDispatcherConfig } from './webhook-types.js';
import { createWebhookHeaders } from './webhook-signer.js';

const EVENT_VERSION = 1;

function isSafeEventType(eventType: string): boolean {
  const safeTypes = new Set([
    'KIMAI_CONNECTION_HEALTH_CHANGED',
    'KIMAI_FIRM_INITIALIZED',
    'KIMAI_MAPPING_CREATED',
    'KIMAI_MAPPING_FAILED',
    'KIMAI_TIME_ENTRY_CREATED',
    'KIMAI_TIME_ENTRY_UPDATED',
    'KIMAI_TIME_ENTRY_DELETED',
    'KIMAI_TIME_ENTRY_EXPORT_READY',
    'KIMAI_SYNC_FAILED',
    'OPENSIGN_CONNECTION_HEALTH_CHANGED',
    'OPENSIGN_FIRM_INITIALIZED',
    'OPENSIGN_USER_SYNCED',
    'OPENSIGN_WORKFLOW_CREATED',
    'OPENSIGN_WORKFLOW_SENT',
    'OPENSIGN_WORKFLOW_STATUS_CHANGED',
    'OPENSIGN_WORKFLOW_COMPLETED',
    'OPENSIGN_WORKFLOW_CANCELLED',
    'OPENSIGN_WORKFLOW_REMINDER_SENT',
    'OPENSIGN_COMPLETED_PDF_READY',
    'OPENSIGN_CERTIFICATE_READY',
    'OPENSIGN_SYNC_FAILED',
  ]);
  return safeTypes.has(eventType);
}

function deriveExternalProvider(eventType: string): 'kimai' | 'opensign' {
  return eventType.startsWith('OPENSIGN_') ? 'opensign' : 'kimai';
}

function buildWebhookPayload(event: OutboxEvent): WebhookPayload {
  const payload = event.payload as Record<string, unknown>;
  return {
    eventType: event.eventType,
    eventVersion: EVENT_VERSION,
    eventId: event.eventId,
    scenticFirmId: event.scenticFirmId,
    scenticUserId: payload['scenticUserId'] as string | undefined,
    scenticMatterId: payload['scenticMatterId'] as string | undefined,
    scenticDocumentId: payload['scenticDocumentId'] as string | undefined,
    scenticDocumentVersionId: payload['scenticDocumentVersionId'] as string | undefined,
    scenticPhysicalFileId: payload['scenticPhysicalFileId'] as string | undefined,
    scenticSignatureWorkflowId: payload['scenticSignatureWorkflowId'] as string | undefined,
    externalProvider: deriveExternalProvider(event.eventType),
    externalObjectRef: payload['opensignDocumentId'] as string | undefined
      ?? payload['kimaiTimesheetId'] as string | undefined
      ?? payload['kimaiTeamId'] as string | undefined,
    safeSummary: event.safeSummary,
    payload: event.payload,
    occurredAt: event.createdAt,
    correlationId: event.correlationId,
    idempotencyKey: `evt-${event.eventId}`,
  };
}

export class WebhookDispatcher {
  private config: WebhookDispatcherConfig;
  private outbox: EventOutbox;
  private dispatchedCount = 0;
  private deliveredCount = 0;
  private failedCount = 0;

  constructor(config: WebhookDispatcherConfig, outbox: EventOutbox) {
    this.config = config;
    this.outbox = outbox;
  }

  isEnabled(): boolean {
    return this.config.enabled && !!this.config.targetUrl && !!this.config.hmacSecret;
  }

  /**
   * Dispatch a single event to the webhook target.
   * Returns the dispatch result with updated status.
   */
  async dispatchEvent(event: OutboxEvent): Promise<WebhookDispatchResult> {
    if (!this.isEnabled()) {
      return {
        eventId: event.eventId,
        status: 'PENDING',
        attempt: 0,
        error: 'Webhook dispatch is disabled (no target URL or secret configured)',
      };
    }

    if (!isSafeEventType(event.eventType)) {
      return {
        eventId: event.eventId,
        status: 'FAILED_FINAL',
        attempt: 0,
        error: `Unknown event type: ${event.eventType}`,
      };
    }

    const payload = buildWebhookPayload(event);
    const { headers, body } = createWebhookHeaders(this.config.hmacSecret, payload);

    const attempt = event.retryCount + 1;
    this.dispatchedCount++;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const resp = await fetch(this.config.targetUrl, {
        method: 'POST',
        headers: headers as unknown as Record<string, string>,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (resp.status >= 200 && resp.status < 300) {
        this.outbox.markSent(event.eventId);
        this.deliveredCount++;
        return {
          eventId: event.eventId,
          status: 'DELIVERED',
          httpStatus: resp.status,
          attempt,
        };
      }

      // 4xx (except 429) = stop retrying
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
        this.outbox.markFailed(event.eventId);
        this.failedCount++;
        return {
          eventId: event.eventId,
          status: 'FAILED_FINAL',
          httpStatus: resp.status,
          attempt,
          error: `Target returned ${resp.status}`,
        };
      }

      // 429 or 5xx = retryable
      this.outbox.markFailed(event.eventId);
      return {
        eventId: event.eventId,
        status: 'FAILED_RETRYABLE',
        httpStatus: resp.status,
        attempt,
        nextRetryAt: this.calculateNextRetry(event.retryCount + 1),
        error: `Target returned ${resp.status}`,
      };
    } catch (err) {
      // Network error, timeout, etc. = retryable
      this.outbox.markFailed(event.eventId);
      return {
        eventId: event.eventId,
        status: 'FAILED_RETRYABLE',
        attempt,
        nextRetryAt: this.calculateNextRetry(event.retryCount + 1),
        error: 'Network error or timeout',
      };
    }
  }

  /**
   * Dispatch all pending events from the outbox.
   */
  async dispatchAll(): Promise<WebhookDispatchResult[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const pending = this.outbox.getPending();
    const results: WebhookDispatchResult[] = [];

    for (const event of pending) {
      const result = await this.dispatchEvent(event);
      results.push(result);
    }

    return results;
  }

  private calculateNextRetry(retryCount: number): string {
    const backoff = Math.min(
      this.config.initialBackoffMs * Math.pow(2, retryCount),
      this.config.maxBackoffMs,
    );
    return new Date(Date.now() + backoff).toISOString();
  }

  getStats(): { dispatched: number; delivered: number; failed: number; enabled: boolean } {
    return {
      dispatched: this.dispatchedCount,
      delivered: this.deliveredCount,
      failed: this.failedCount,
      enabled: this.isEnabled(),
    };
  }
}

/**
 * Create a default webhook dispatcher config from gateway config.
 */
export function createWebhookDispatcherConfig(opts: {
  targetUrl: string;
  hmacSecret: string;
}): WebhookDispatcherConfig {
  return {
    targetUrl: opts.targetUrl,
    hmacSecret: opts.hmacSecret,
    maxRetries: 5,
    initialBackoffMs: 5_000,
    maxBackoffMs: 600_000,
    timeoutMs: 30_000,
    enabled: !!opts.targetUrl && !!opts.hmacSecret,
  };
}
