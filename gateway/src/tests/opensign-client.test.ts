import { describe, it, expect, beforeEach, vi } from 'vitest';

import { makeApp, makeMockOpenSignClient, type TestApp } from './helpers.js';

const FIRM1 = 'firm-11111111';
const USER1 = 'user-uuuuuuuu';

describe('OpenSign client / health / error wrapping / unsupported — tests F–I', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp();
  });

  // F. Health check handles healthy response
  it('F: checkHealth reports reachable=true when getStatus returns reachable:true', async () => {
    const opensignClient = makeMockOpenSignClient({
      getStatus: vi.fn(async () => ({ success: true, data: { reachable: true, appId: 'opensign' } })),
    });
    const app = makeApp({ opensignClient });

    const r = await app.opensignService!.checkHealth();
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.reachable).toBe(true);
    }
  });

  // G. Health check handles down response safely
  it('G: checkHealth reports reachable=false without crashing when getStatus fails', async () => {
    // The real OpenSignClient.getStatus wraps fetch failures into a
    // { success: false } result (it never throws). The service's checkHealth
    // then returns reachable=false. Simulate that exact shape.
    const opensignClient = makeMockOpenSignClient({
      getStatus: vi.fn(async () => ({
        success: false,
        error: { code: 'OPENSIGN_UNREACHABLE', message: 'OpenSign server is not reachable' },
      })),
    });
    const app = makeApp({ opensignClient });

    // Must not throw — the service maps a failed getStatus to reachable=false.
    const r = await app.opensignService!.checkHealth();
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.reachable).toBe(false);
    }
  });

  // H. Raw OpenSign error wrapped safely
  it('H: raw OpenSign error details are never included in the wrapped service error', async () => {
    const rawMarker = 'RAW_OPENSIGN_SECRET_BODY_xyz';
    const opensignClient = makeMockOpenSignClient({
      createTenant: vi.fn(async () => ({
        success: false,
        error: { code: 'OPENSIGN_API_ERROR', message: rawMarker },
      })),
    });
    const app = makeApp({ opensignClient });

    const r = await app.opensignService!.initFirm(
      { scenticFirmId: FIRM1, firmName: 'Acme Law' },
      'corr',
    );

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.message).not.toContain(rawMarker);
      // The wrapped message is a safe generic form.
      expect(r.error.message).toMatch(/OpenSign.*createTenant.*failed/);
    }
  });

  // I. Unsupported operation returns NOT_SUPPORTED
  it('I: sendReminder via service returns NOT_SUPPORTED', async () => {
    // Set up a firm + workflow so the mapping exists (sendReminder checks the mapping first).
    await t.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    const wf = await t.opensignService!.createWorkflow(
      {
        scenticFirmId: FIRM1,
        scenticSignatureWorkflowId: 'wf-1',
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
    expect(wf.success).toBe(true);

    const r = await t.opensignService!.sendReminder(FIRM1, 'wf-1', [USER1], 'corr');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('NOT_SUPPORTED');
      expect(r.error.statusCode).toBe(501);
    }
  });
});
