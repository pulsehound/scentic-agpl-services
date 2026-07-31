import { describe, it, expect, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeApp, signedRequest, request, type TestApp } from './helpers.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scenticCoreRoot = 'C:\\AIprojects\\factoryai\\scentic.ai';

const FIRM1 = 'firm-11111111';
const FIRM2 = 'firm-22222222';
const USER1 = 'user-uuuuuuuu';

const SIGNER_EMAIL = 'signer@example.com';
const DOC_URL = 'http://opensign/files/test.pdf';
const OPENSIGN_SHA = 'f72624fa26211fe00776453d99a67120a4f5e060';

describe('OpenSign security (PII hygiene, source offer, vendor pin, core boundary) — tests AC–AI', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp();
  });

  // AC. No raw signer emails / signing links in logs/events
  it('AC: outbox events contain no raw signer emails or signing URLs', async () => {
    await t.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    await t.opensignService!.createWorkflow(
      {
        scenticFirmId: FIRM1,
        scenticSignatureWorkflowId: 'wf-sec',
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

    const events = t.outbox.getAll();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      const payloadStr = JSON.stringify(e.payload);
      expect(payloadStr).not.toContain(SIGNER_EMAIL);
      expect(e.safeSummary).not.toContain(SIGNER_EMAIL);
      // No signing links.
      expect(payloadStr).not.toContain('http://opensign/signed/');
    }
  });

  // AD. Document source URL is not logged
  it('AD: outbox events contain no document source URL or base64 content', async () => {
    await t.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    await t.opensignService!.createWorkflow(
      {
        scenticFirmId: FIRM1,
        scenticSignatureWorkflowId: 'wf-url',
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

    for (const e of t.outbox.getAll()) {
      const payloadStr = JSON.stringify(e.payload);
      expect(payloadStr).not.toContain(DOC_URL);
      expect(payloadStr).not.toContain('dGVzdA==');
    }
  });

  // AE. Cross-Firm workflow probing returns safe denial
  it('AE: probing a firm1 workflow from a firm2 context returns 404, not 500', async () => {
    await t.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    await t.opensignService!.initFirm({ scenticFirmId: FIRM2, firmName: 'Beta Law' }, 'corr');
    await t.opensignService!.createWorkflow(
      {
        scenticFirmId: FIRM1,
        scenticSignatureWorkflowId: 'wf-probe',
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

    const res = await signedRequest(t.app, {
      method: 'GET',
      path: `/api/v1/firms/${FIRM2}/signature/workflows/wf-probe`,
      firmId: FIRM2,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // AF. Source endpoint does not expose secrets
  it('AF: GET /source exposes no secrets, no @scentic/ imports, and includes an OpenSign license note', async () => {
    const res = await request(t.app).get('/source');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const text = res.text;
    expect(text).not.toContain(t.config.opensignMasterKey);
    expect(text).not.toContain(t.config.opensignAdminPassword);
    expect(text).not.toContain(t.config.hmacSecret);
    expect(text).not.toContain('@scentic/');

    // OpenSign license inconsistency is documented in the source offer response.
    const opensignUpstream = res.body.data.upstream.opensign;
    expect(opensignUpstream.license).toBe('AGPL-3.0');
    expect(opensignUpstream.licenseNote).toBeDefined();
    expect(opensignUpstream.pinnedCommit).toBe(OPENSIGN_SHA);
  });

  // AG. OpenSign upstream vendor remains unmodified
  it('AG: vendor/opensign is checked out at the pinned AGPL-02 SHA', () => {
    const opensignDir = path.join(repoRoot, 'vendor', 'opensign');
    const head = execSync(`git -C "${opensignDir}" rev-parse HEAD`, { encoding: 'utf-8' }).trim();
    expect(head).toBe(OPENSIGN_SHA);
  });

  // AH. No Scentic core files modified
  it('AH: scentic.ai git status has no AGPL / gateway / opensign references', () => {
    let status: string;
    try {
      status = execSync(`git -C "${scenticCoreRoot}" status --porcelain`, { encoding: 'utf-8' });
    } catch (err) {
      throw new Error(`Unable to read git status from scentic.ai at ${scenticCoreRoot}: ${err}`);
    }

    // None of the modified/untracked files should reference AGPL gateway/opensign work.
    const agplReferences = status
      .split('\n')
      .filter(l => l.trim())
      .filter(l => /agpl|gateway|opensign/i.test(l));

    expect(agplReferences).toHaveLength(0);
  });

  // AI. No AGPL code introduced into Scentic core
  it('AI: no AGPL-licensed gateway/opensign source files exist inside the scentic.ai repo', () => {
    let status: string;
    try {
      status = execSync(`git -C "${scenticCoreRoot}" status --porcelain`, { encoding: 'utf-8' });
    } catch (err) {
      throw new Error(`Unable to read git status from scentic.ai at ${scenticCoreRoot}: ${err}`);
    }

    // Complementary to AH: assert the whole status output is free of opensign/agpl paths.
    expect(status.toLowerCase()).not.toContain('opensign');
    expect(status.toLowerCase()).not.toContain('agpl');
  });
});
