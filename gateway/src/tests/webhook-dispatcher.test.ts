import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { makeApp, type TestApp } from './helpers.js';
import { WebhookDispatcher, createWebhookDispatcherConfig } from '../events/webhook-dispatcher.js';
import { createWebhookHeaders, verifyWebhookSignature } from '../events/webhook-signer.js';
import type { WebhookPayload } from '../events/webhook-types.js';
import type { OutboxEvent } from '../events/outbox.js';

const FIRM1 = 'firm-11111111';
const USER1 = 'user-uuuuuuuu';

/**
 * Helper: publish a representative event into the outbox and return it.
 */
async function publishKimaiEvent(t: TestApp, firmId: string): Promise<OutboxEvent> {
  return await t.outbox.publish({
    eventType: 'KIMAI_TIME_ENTRY_CREATED',
    scenticFirmId: firmId,
    correlationId: 'corr-test',
    payload: {
      scenticUserId: USER1,
      scenticTimeEntryId: 'te-1',
      kimaiTimesheetId: 601,
    },
    safeSummary: `Time entry created for firm ${firmId}`,
  });
}

describe('Webhook dispatcher (signing, dispatch, retry, idempotency, payload safety) â€” tests Eâ€“L', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp({ enableWebhook: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // E. Event signed with webhook secret
  it('E: dispatched event request carries X-Gateway-Signature with sha256= prefix', async () => {
    const event = await publishKimaiEvent(t, FIRM1);

    let capturedHeaders: Record<string, string> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response('ok', { status: 200 });
    });

    const result = await t.webhookDispatcher!.dispatchEvent(event);

    expect(result.status).toBe('DELIVERED');
    expect(capturedHeaders).toBeDefined();
    const sig = capturedHeaders!['X-Gateway-Signature'];
    expect(sig).toBeDefined();
    expect(sig.startsWith('sha256=')).toBe(true);
    // sha256= prefix followed by a 64-char hex digest
    expect(sig.length).toBe('sha256='.length + 64);
  });

  // F. Missing webhook target disables dispatch safely
  it('F: empty targetUrl makes isEnabled() false and dispatchEvent returns PENDING', async () => {
    const dispatcher = new WebhookDispatcher(
      createWebhookDispatcherConfig({ targetUrl: '', hmacSecret: 'test-webhook-hmac-secret' }),
      t.outbox,
    );

    expect(dispatcher.isEnabled()).toBe(false);

    const event = await publishKimaiEvent(t, FIRM1);
    const result = await dispatcher.dispatchEvent(event);

    expect(result.status).toBe('PENDING');
    expect(result.attempt).toBe(0);
    expect(result.error).toMatch(/disabled/i);
  });

  // G. Webhook target down creates retryable failure
  it('G: network error against target produces FAILED_RETRYABLE', async () => {
    const event = await publishKimaiEvent(t, FIRM1);

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await t.webhookDispatcher!.dispatchEvent(event);

    expect(result.status).toBe('FAILED_RETRYABLE');
    expect(result.error).toMatch(/network error|timeout|ECONNREFUSED/i);
    expect(result.nextRetryAt).toBeDefined();
  });

  // H. Delivered event marked delivered
  it('H: 200 response marks event DELIVERED and outbox event SENT', async () => {
    const event = await publishKimaiEvent(t, FIRM1);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('ok', { status: 200 }),
    );

    const result = await t.webhookDispatcher!.dispatchEvent(event);

    expect(result.status).toBe('DELIVERED');
    expect(result.httpStatus).toBe(200);

    const outboxEvent = (await t.outbox.getAll()).find(e => e.eventId === event.eventId);
    expect(outboxEvent).toBeDefined();
    expect(outboxEvent!.status).toBe('SENT');
  });

  // I. Failed event retries with backoff
  it('I: 5xx response sets FAILED_RETRYABLE, increments retryCount, sets nextRetryAt', async () => {
    const event = await publishKimaiEvent(t, FIRM1);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('error', { status: 503 }),
    );

    const result = await t.webhookDispatcher!.dispatchEvent(event);

    expect(result.status).toBe('FAILED_RETRYABLE');
    expect(result.httpStatus).toBe(503);
    expect(result.nextRetryAt).toBeDefined();
    expect(typeof result.nextRetryAt).toBe('string');
    // nextRetryAt must be a valid ISO date in the future
    const retryAt = new Date(result.nextRetryAt!);
    expect(retryAt.getTime()).toBeGreaterThan(Date.now());

    const outboxEvent = (await t.outbox.getAll()).find(e => e.eventId === event.eventId);
    expect(outboxEvent).toBeDefined();
    expect(outboxEvent!.retryCount).toBeGreaterThanOrEqual(1);
  });

  // J. Duplicate event dispatch uses same idempotency key
  it('J: dispatching the same event twice sends the same Idempotency-Key header', async () => {
    const event = await publishKimaiEvent(t, FIRM1);

    const capturedKeys: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers as Record<string, string>) ?? {};
      capturedKeys.push(headers['Idempotency-Key']);
      return new Response('ok', { status: 200 });
    });

    // First dispatch marks the event SENT; re-publish a fresh identical event
    // and dispatch again to compare idempotency keys for the SAME eventId.
    // The idempotency key is derived as `evt-<eventId>`, so two dispatches of
    // the same event must produce the same key.
    await t.webhookDispatcher!.dispatchEvent(event);
    // Reset the outbox event back to PENDING so it can be dispatched again.
    const outboxEvent = (await t.outbox.getAll()).find(e => e.eventId === event.eventId);
    if (outboxEvent) outboxEvent.status = 'PENDING';
    await t.webhookDispatcher!.dispatchEvent(event);

    expect(capturedKeys).toHaveLength(2);
    expect(capturedKeys[0]).toBeDefined();
    expect(capturedKeys[1]).toBeDefined();
    expect(capturedKeys[0]).toBe(capturedKeys[1]);
    expect(capturedKeys[0]).toBe(`evt-${event.eventId}`);
  });

  // K. Payload does not contain document contents / signing links / raw signer emails
  it('K: webhook payload omits documentBase64, SignedUrl, and raw signer emails', async () => {
    // Use the real OpenSign service to create a workflow that receives
    // documentBase64 and signer emails, then dispatch the resulting
    // OPENSIGN_WORKFLOW_CREATED event and inspect the serialized webhook body.
    const app = makeApp({ enableWebhook: true, enableOpenSign: true });
    await app.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    await app.opensignService!.syncUser(
      { scenticFirmId: FIRM1, scenticUserId: USER1, email: 'u@example.com', name: 'User One' },
      'corr',
    );
    const signerEmail = 'signer@example.com';
    const docBase64 = 'dGVzdCBkb2N1bWVudCBjb250ZW50cyAtIFNFQ1JFVA==';
    const createRes = await app.opensignService!.createWorkflow(
      {
        scenticFirmId: FIRM1,
        scenticSignatureWorkflowId: 'wf-K',
        scenticMatterId: 'matter-1',
        scenticDocumentId: 'doc-1',
        scenticDocumentVersionId: 'v-1',
        scenticPhysicalFileId: 'pf-1',
        documentName: 'contract.pdf',
        documentBase64: docBase64,
        signers: [{ scenticSignerId: USER1, email: signerEmail, name: 'Signer One', role: 'signer', order: 1 }],
        sendNow: true,
      },
      'corr',
    );
    expect(createRes.success).toBe(true);

    const wfEvent = (await app.outbox.getAll()).find(e => e.eventType === 'OPENSIGN_WORKFLOW_CREATED');
    expect(wfEvent).toBeDefined();

    let capturedBody: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = typeof init?.body === 'string' ? init.body : '';
      return new Response('ok', { status: 200 });
    });

    const result = await app.webhookDispatcher!.dispatchEvent(wfEvent!);
    expect(result.status).toBe('DELIVERED');

    expect(capturedBody).toBeDefined();
    // Must NOT contain the raw document contents
    expect(capturedBody).not.toContain(docBase64);
    expect(capturedBody).not.toContain('documentBase64');
    // Must NOT contain signing links
    expect(capturedBody).not.toContain('SignedUrl');
    // Must NOT contain the raw signer email in plaintext
    expect(capturedBody).not.toContain(signerEmail);
    // Payload still carries the firm id (sanity)
    expect(capturedBody).toContain(FIRM1);
  });

  // L. Signature verification sample passes
  it('L: verifyWebhookSignature accepts a signature produced by createWebhookHeaders', () => {
    const secret = 'test-webhook-hmac-secret';
    const payload: WebhookPayload = {
      eventType: 'KIMAI_TIME_ENTRY_CREATED',
      eventVersion: 1,
      eventId: 'evt-verify-1',
      scenticFirmId: FIRM1,
      externalProvider: 'kimai',
      safeSummary: 'test summary',
      payload: { scenticTimeEntryId: 'te-1' },
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-verify-1',
      idempotencyKey: 'evt-evt-verify-1',
    };

    const { headers, body } = createWebhookHeaders(secret, payload);

    const ok = verifyWebhookSignature(
      secret,
      body,
      headers['X-Gateway-Timestamp'],
      headers['X-Gateway-Nonce'],
      headers['X-Gateway-Event-Id'],
      headers['X-Gateway-Firm-Id'],
      headers['X-Gateway-Correlation-Id'],
      headers['X-Gateway-Signature'],
    );

    expect(ok).toBe(true);

    // And a wrong secret must fail
    const bad = verifyWebhookSignature(
      'wrong-secret',
      body,
      headers['X-Gateway-Timestamp'],
      headers['X-Gateway-Nonce'],
      headers['X-Gateway-Event-Id'],
      headers['X-Gateway-Firm-Id'],
      headers['X-Gateway-Correlation-Id'],
      headers['X-Gateway-Signature'],
    );
    expect(bad).toBe(false);
  });
});
