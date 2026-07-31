import { describe, it, expect, beforeEach, vi } from 'vitest';

import { makeApp, makeMockOpenSignClient, type TestApp } from './helpers.js';

const FIRM1 = 'firm-11111111';
const USER1 = 'user-uuuuuuuu';

const SIGNER_EMAIL = 'signer@example.com';
const DOC_URL = 'http://opensign/files/test.pdf';
const SIGNED_URL = 'http://opensign/signed/test.pdf';
const CERT_URL = 'http://opensign/cert/test.pdf';

function completedDocOverrides() {
  return {
    getDocument: vi.fn(async () => ({
      success: true,
      data: {
        objectId: 'doc-1',
        Name: 'Test Doc',
        URL: DOC_URL,
        SignedUrl: SIGNED_URL,
        CertificateUrl: CERT_URL,
        IsCompleted: true,
        IsDeclined: false,
        IsArchive: false,
        Signers: [],
        Placeholders: [],
        AuditTrail: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    })),
  };
}

describe('OpenSign polling (status change, dedup, failure, safe refs) — tests Y–AB', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp();
  });

  async function setupCompletedWorkflow(app: TestApp) {
    await app.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    await app.opensignService!.createWorkflow(
      {
        scenticFirmId: FIRM1,
        scenticSignatureWorkflowId: 'wf-poll',
        scenticMatterId: 'matter-1',
        scenticDocumentId: 'doc-1',
        scenticDocumentVersionId: 'v-1',
        scenticPhysicalFileId: 'pf-1',
        documentName: 'contract.pdf',
        documentBase64: 'dGVzdA==',
        signers: [{ scenticSignerId: USER1, email: SIGNER_EMAIL, name: 'Signer One', role: 'signer', order: 1 }],
        sendNow: true,
      },
      'corr',
    );
  }

  // Y. Polling status change creates one event (status changed + completed)
  it('Y: polling a DRAFT→COMPLETED transition emits STATUS_CHANGED and COMPLETED events', async () => {
    const opensignClient = makeMockOpenSignClient(completedDocOverrides());
    const app = makeApp({ opensignClient });
    await setupCompletedWorkflow(app);

    const r = await app.opensignService!.pollWorkflow(FIRM1, 'wf-poll', 'corr');
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.changed).toBe(true);
      expect(r.data.status).toBe('COMPLETED');
    }

    const events = await app.outbox.getAll();
    const statusChanged = events.filter(e => e.eventType === 'OPENSIGN_WORKFLOW_STATUS_CHANGED');
    const completed = events.filter(e => e.eventType === 'OPENSIGN_WORKFLOW_COMPLETED');
    expect(statusChanged.length).toBeGreaterThanOrEqual(1);
    expect(completed.length).toBe(1);
  });

  // Z. Duplicate poll does not duplicate completion event (terminal state skip)
  it('Z: a second poll after completion does not emit a new COMPLETED event', async () => {
    const opensignClient = makeMockOpenSignClient(completedDocOverrides());
    const app = makeApp({ opensignClient });
    await setupCompletedWorkflow(app);

    await app.opensignService!.pollWorkflow(FIRM1, 'wf-poll', 'corr');
    const completedAfterFirst = (await app.outbox.getAll()).filter(e => e.eventType === 'OPENSIGN_WORKFLOW_COMPLETED').length;
    expect(completedAfterFirst).toBe(1);

    // Second poll — workflow is now COMPLETED (terminal), so it skips.
    const r2 = await app.opensignService!.pollWorkflow(FIRM1, 'wf-poll', 'corr');
    expect(r2.success).toBe(true);
    if (r2.success) {
      expect(r2.data.changed).toBe(false);
    }

    const completedAfterSecond = (await app.outbox.getAll()).filter(e => e.eventType === 'OPENSIGN_WORKFLOW_COMPLETED').length;
    expect(completedAfterSecond).toBe(1);
  });

  // AA. OpenSign down during poll creates safe retry/failure state
  it('AA: when getDocument fails, poll returns UPSTREAM_UNAVAILABLE and emits a health-changed event', async () => {
    const opensignClient = makeMockOpenSignClient({
      getDocument: vi.fn(async () => ({
        success: false,
        error: { code: 'OPENSIGN_UNREACHABLE', message: 'OpenSign server is not reachable' },
      })),
    });
    const app = makeApp({ opensignClient });
    await setupCompletedWorkflow(app);

    const r = await app.opensignService!.pollWorkflow(FIRM1, 'wf-poll', 'corr');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('UPSTREAM_UNAVAILABLE');
    }

    const healthEvents = (await app.outbox.getAll()).filter(e => e.eventType === 'OPENSIGN_CONNECTION_HEALTH_CHANGED');
    expect(healthEvents.length).toBeGreaterThanOrEqual(1);
  });

  // AB. Completion event includes only safe refs
  it('AB: completion event payloads contain no document contents, signing links, or signer emails', async () => {
    const opensignClient = makeMockOpenSignClient(completedDocOverrides());
    const app = makeApp({ opensignClient });
    await setupCompletedWorkflow(app);

    await app.opensignService!.pollWorkflow(FIRM1, 'wf-poll', 'corr');

    const events = await app.outbox.getAll();
    expect(events.length).toBeGreaterThan(0);

    for (const e of events) {
      const payloadStr = JSON.stringify(e.payload);
      const summaryStr = e.safeSummary;
      // No raw signer emails.
      expect(payloadStr).not.toContain(SIGNER_EMAIL);
      expect(summaryStr).not.toContain(SIGNER_EMAIL);
      // No signing links / certificate URLs.
      expect(payloadStr).not.toContain(SIGNED_URL);
      expect(payloadStr).not.toContain(CERT_URL);
      // No document source URLs.
      expect(payloadStr).not.toContain(DOC_URL);
      // No base64 document content.
      expect(payloadStr).not.toContain('dGVzdA==');
    }
  });
});
