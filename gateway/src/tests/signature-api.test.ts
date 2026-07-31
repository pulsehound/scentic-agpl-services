import { describe, it, expect, beforeEach } from 'vitest';

import { makeApp, signedRequest, type TestApp } from './helpers.js';

const FIRM1 = 'firm-11111111';
const FIRM2 = 'firm-22222222';
const USER1 = 'user-uuuuuuuu';

async function setupFirm(t: TestApp, firmId: string, firmName: string) {
  await t.opensignService!.initFirm({ scenticFirmId: firmId, firmName }, 'corr');
}

async function createWorkflow(t: TestApp, firmId: string, workflowId: string) {
  const r = await t.opensignService!.createWorkflow(
    {
      scenticFirmId: firmId,
      scenticSignatureWorkflowId: workflowId,
      scenticMatterId: 'matter-1',
      scenticDocumentId: 'doc-1',
      scenticDocumentVersionId: 'v-1',
      scenticPhysicalFileId: 'pf-1',
      documentName: 'contract.pdf',
      documentBase64: 'dGVzdA==',
      signers: [{ scenticSignerId: USER1, email: 'signer@example.com', name: 'Signer One', role: 'signer', order: 1 }],
      sendNow: true,
    },
    'corr',
  );
  expect(r.success).toBe(true);
  return r;
}

describe('Signature API (firm filtering, idempotency, events) — tests O–X', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp();
  });

  // O. Create workflow requires Firm/User/Matter/Document scope
  it('O: POST /signature/workflows without scenticSignatureWorkflowId returns 400', async () => {
    await setupFirm(t, FIRM1, 'Acme Law');

    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM1}/signature/workflows`,
      bodyObj: {
        scenticDocumentId: 'doc-1',
        documentName: 'contract.pdf',
        documentBase64: 'dGVzdA==',
        signers: [{ scenticSignerId: USER1, email: 'signer@example.com', name: 'Signer One', role: 'signer', order: 1 }],
      },
      firmId: FIRM1,
      idempotencyKey: 'idem-O',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  // P. Create workflow is idempotent
  it('P: creating a workflow twice with the same scenticSignatureWorkflowId returns the existing mapping', async () => {
    await setupFirm(t, FIRM1, 'Acme Law');

    const body = {
      scenticSignatureWorkflowId: 'wf-idem',
      scenticMatterId: 'matter-1',
      scenticDocumentId: 'doc-1',
      documentName: 'contract.pdf',
      documentBase64: 'dGVzdA==',
      signers: [{ scenticSignerId: USER1, email: 'signer@example.com', name: 'Signer One', role: 'signer', order: 1 }],
    };

    const first = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM1}/signature/workflows`,
      bodyObj: body,
      firmId: FIRM1,
      idempotencyKey: 'idem-P1',
    });
    expect(first.status).toBe(200);
    const firstId = first.body.data.id;
    const firstDocId = first.body.data.opensignDocumentId;

    const createDocCallsAfterFirst = t.opensignClient!.createDocument.mock.calls.length;

    const second = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM1}/signature/workflows`,
      bodyObj: body,
      firmId: FIRM1,
      idempotencyKey: 'idem-P2',
    });
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(firstId);
    expect(second.body.data.opensignDocumentId).toBe(firstDocId);

    // No additional OpenSign document creation on the idempotent second call.
    expect(t.opensignClient!.createDocument.mock.calls.length).toBe(createDocCallsAfterFirst);
  });

  // Q. Send workflow creates sent event
  it('Q: POST /signature/workflows/:id/send creates an OPENSIGN_WORKFLOW_SENT outbox event', async () => {
    await setupFirm(t, FIRM1, 'Acme Law');
    await createWorkflow(t, FIRM1, 'wf-send');

    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM1}/signature/workflows/wf-send/send`,
      firmId: FIRM1,
      idempotencyKey: 'idem-Q',
    });
    expect(res.status).toBe(200);

    const sentEvents = t.outbox.getAll().filter(e => e.eventType === 'OPENSIGN_WORKFLOW_SENT');
    expect(sentEvents.length).toBeGreaterThanOrEqual(1);
    expect(sentEvents.some(e => e.payload['scenticSignatureWorkflowId'] === 'wf-send')).toBe(true);
  });

  // R. Get workflow Firm-filtered
  it('R: GET workflow from firm2 (created in firm1) returns 404', async () => {
    await setupFirm(t, FIRM1, 'Acme Law');
    await setupFirm(t, FIRM2, 'Beta Law');
    await createWorkflow(t, FIRM1, 'wf-get');

    const res = await signedRequest(t.app, {
      method: 'GET',
      path: `/api/v1/firms/${FIRM2}/signature/workflows/wf-get`,
      firmId: FIRM2,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // S. Cancel workflow cannot cross Firm
  it('S: POST cancel from firm2 (workflow in firm1) returns 404', async () => {
    await setupFirm(t, FIRM1, 'Acme Law');
    await setupFirm(t, FIRM2, 'Beta Law');
    await createWorkflow(t, FIRM1, 'wf-cancel');

    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM2}/signature/workflows/wf-cancel/cancel`,
      bodyObj: { reason: 'test' },
      firmId: FIRM2,
      idempotencyKey: 'idem-S',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // T. Reminder cannot cross Firm
  it('T: POST remind from firm2 (workflow in firm1) returns 404', async () => {
    await setupFirm(t, FIRM1, 'Acme Law');
    await setupFirm(t, FIRM2, 'Beta Law');
    await createWorkflow(t, FIRM1, 'wf-remind');

    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM2}/signature/workflows/wf-remind/remind`,
      bodyObj: { scenticSignerIds: [USER1] },
      firmId: FIRM2,
      idempotencyKey: 'idem-T',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // U. Poll workflow cannot cross Firm
  it('U: POST poll from firm2 (workflow in firm1) returns 404', async () => {
    await setupFirm(t, FIRM1, 'Acme Law');
    await setupFirm(t, FIRM2, 'Beta Law');
    await createWorkflow(t, FIRM1, 'wf-poll');

    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM2}/signature/workflows/wf-poll/poll`,
      firmId: FIRM2,
      idempotencyKey: 'idem-U',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // V. Completed PDF endpoint cannot cross Firm
  it('V: GET completed from firm2 (workflow in firm1) returns 404', async () => {
    await setupFirm(t, FIRM1, 'Acme Law');
    await setupFirm(t, FIRM2, 'Beta Law');
    await createWorkflow(t, FIRM1, 'wf-completed');

    const res = await signedRequest(t.app, {
      method: 'GET',
      path: `/api/v1/firms/${FIRM2}/signature/workflows/wf-completed/completed`,
      firmId: FIRM2,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // W. Completed PDF endpoint returns safe not-ready state
  it('W: GET completed for a non-completed workflow returns { ready: false }', async () => {
    await setupFirm(t, FIRM1, 'Acme Law');
    await createWorkflow(t, FIRM1, 'wf-notready');

    const res = await signedRequest(t.app, {
      method: 'GET',
      path: `/api/v1/firms/${FIRM1}/signature/workflows/wf-notready/completed`,
      firmId: FIRM1,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.ready).toBe(false);
    expect(res.body.data.certificateReady).toBe(false);
  });

  // X. Unsupported remind returns safe NOT_SUPPORTED
  it('X: POST remind for an existing workflow returns NOT_SUPPORTED (OpenSign has no manual reminder API)', async () => {
    await setupFirm(t, FIRM1, 'Acme Law');
    await createWorkflow(t, FIRM1, 'wf-remind-x');

    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM1}/signature/workflows/wf-remind-x/remind`,
      bodyObj: { scenticSignerIds: [USER1] },
      firmId: FIRM1,
      idempotencyKey: 'idem-X',
    });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('NOT_SUPPORTED');
  });
});
