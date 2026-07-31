import { describe, it, expect, beforeEach } from 'vitest';

import { makeApp, type TestApp } from './helpers.js';

const FIRM1 = 'firm-11111111';
const FIRM2 = 'firm-22222222';
const USER1 = 'user-uuuuuuuu';

describe('OpenSign mappings (firm scoping, isolation, probing) — tests J–N', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp();
  });

  // J. OpenSign Firm mapping is Firm-scoped
  it('J: an OpenSign firm mapping in firm1 is not visible from firm2', async () => {
    await t.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');

    expect(await t.store.getOpenSignFirmMapping(FIRM1)).not.toBeNull();
    expect(await t.store.getOpenSignFirmMapping(FIRM2)).toBeNull();
  });

  // K. OpenSign user mapping is Firm-scoped
  it('K: an OpenSign user mapping in firm1 is not visible from firm2', async () => {
    await t.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    await t.opensignService!.syncUser(
      { scenticFirmId: FIRM1, scenticUserId: USER1, email: `${USER1}@example.com`, name: 'User One' },
      'corr',
    );

    expect(await t.store.getOpenSignUserMapping(FIRM1, USER1)).not.toBeNull();
    expect(await t.store.getOpenSignUserMapping(FIRM2, USER1)).toBeNull();
  });

  // L. Same Scentic user can map separately in two Firms
  it('L: the same scenticUserId creates two distinct OpenSign user mappings in two firms', async () => {
    await t.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    await t.opensignService!.initFirm({ scenticFirmId: FIRM2, firmName: 'Beta Law' }, 'corr');
    await t.opensignService!.syncUser(
      { scenticFirmId: FIRM1, scenticUserId: USER1, email: `${USER1}@example.com`, name: 'User One' },
      'corr',
    );
    await t.opensignService!.syncUser(
      { scenticFirmId: FIRM2, scenticUserId: USER1, email: `${USER1}@example.com`, name: 'User One' },
      'corr',
    );

    const m1 = await t.store.getOpenSignUserMapping(FIRM1, USER1);
    const m2 = await t.store.getOpenSignUserMapping(FIRM2, USER1);

    expect(m1).not.toBeNull();
    expect(m2).not.toBeNull();
    expect(m1!.id).not.toBe(m2!.id);
    expect(m1!.scenticFirmId).toBe(FIRM1);
    expect(m2!.scenticFirmId).toBe(FIRM2);
    expect(m1!.scenticUserId).toBe(USER1);
    expect(m2!.scenticUserId).toBe(USER1);
  });

  // M. OpenSign workflow mapping cannot cross Firm
  it('M: a workflow created in firm1 returns 404 (NOT_FOUND) when queried from firm2', async () => {
    await t.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    await t.opensignService!.createWorkflow(
      {
        scenticFirmId: FIRM1,
        scenticSignatureWorkflowId: 'wf-cross',
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

    const r = await t.opensignService!.getWorkflowStatus(FIRM2, 'wf-cross', 'corr');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('NOT_FOUND');
      expect(r.error.statusCode).toBe(404);
    }
  });

  // N. Direct mapping ID probing safe
  it('N: probing a non-existent workflow returns 404 NOT_FOUND, not 500', async () => {
    const r = await t.opensignService!.getWorkflowStatus(FIRM1, 'does-not-exist', 'corr');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('NOT_FOUND');
      expect(r.error.statusCode).toBe(404);
    }
  });
});
