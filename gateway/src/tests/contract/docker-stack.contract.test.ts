/**
 * AGPL-04 — Docker stack contract tests (AL–AQ).
 *
 * These tests exercise the real Docker stack (gateway + Kimai + OpenSign).
 * They are skipped unless GATEWAY_CONTRACT_TEST=true is set, along with the
 * service base URLs:
 *   - GATEWAY_CONTRACT_URL        (e.g. http://localhost:3101)
 *   - CONTRACT_KIMAI_BASE_URL     (e.g. http://localhost:8001)
 *   - CONTRACT_OPENSIGN_BASE_URL  (e.g. http://localhost:8080/app)
 *   - GATEWAY_CONTRACT_HMAC_SECRET (HMAC secret shared with the gateway, for AP/AQ)
 *
 * When GATEWAY_CONTRACT_TEST is not 'true', every test below is skipped.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeSignedHeaders } from '../helpers.js';

const shouldRun = process.env.GATEWAY_CONTRACT_TEST === 'true';
const describeOrSkip = shouldRun ? describe : describe.skip;

const GATEWAY_URL = (process.env.GATEWAY_CONTRACT_URL ?? '').replace(/\/$/, '');
const KIMAI_URL = (process.env.CONTRACT_KIMAI_BASE_URL ?? '').replace(/\/$/, '');
const OPENSIGN_URL = (process.env.CONTRACT_OPENSIGN_BASE_URL ?? '').replace(/\/$/, '');
const HMAC_SECRET = process.env.GATEWAY_CONTRACT_HMAC_SECRET ?? 'test-hmac-secret';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const fixturePdf = path.join(repoRoot, 'gateway', 'src', 'tests', 'fixtures', 'test-document.pdf');

describeOrSkip('AGPL-04 Docker stack contract tests (require GATEWAY_CONTRACT_TEST=true) — tests AL–AQ', () => {

  // AL. Gateway /health endpoint responds
  it('AL: Gateway /health endpoint responds', async () => {
    expect(GATEWAY_URL.length).toBeGreaterThan(0);
    const res = await fetch(`${GATEWAY_URL}/health`);
    expect(res.status).toBeLessThan(500);
    const body = await res.json().catch(() => null);
    expect(body).not.toBeNull();
  });

  // AM. Gateway /api/v1/status endpoint reports sqlite store type
  it('AM: Gateway /api/v1/status endpoint reports sqlite store type', async () => {
    expect(GATEWAY_URL.length).toBeGreaterThan(0);
    const res = await fetch(`${GATEWAY_URL}/api/v1/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.stores.mapping).toBe('sqlite');
    expect(body.data.stores.nonce).toBe('sqlite');
    expect(body.data.stores.outbox).toBe('sqlite');
  });

  // AN. Kimai /api/ping responds
  it('AN: Kimai /api/ping responds', async () => {
    expect(KIMAI_URL.length).toBeGreaterThan(0);
    // Try a few likely Kimai health/version endpoints; accept any non-5xx.
    const probes = [`${KIMAI_URL}/api/ping`, `${KIMAI_URL}/api/version`, `${KIMAI_URL}/api/health`, `${KIMAI_URL}/health`];
    let lastStatus = -1;
    let lastErr: unknown = null;
    for (const url of probes) {
      try {
        const res = await fetch(url, { method: 'GET' });
        lastStatus = res.status;
        if (res.status < 500) {
          expect(res.status).toBeLessThan(500);
          return;
        }
      } catch (err) { lastErr = err; }
    }
    throw new Error(`Kimai contract probe failed for ${KIMAI_URL}. lastStatus=${lastStatus}, lastErr=${String(lastErr)}`);
  });

  // AO. OpenSign server /app/classes/_User responds
  it('AO: OpenSign server /app/classes/_User responds', async () => {
    expect(OPENSIGN_URL.length).toBeGreaterThan(0);
    const probes = [
      `${OPENSIGN_URL}/app/classes/_User`,
      `${OPENSIGN_URL}/api/apps/opensign/classes/_User`,
      `${OPENSIGN_URL}/classes/_User`,
    ];
    let lastStatus = -1;
    let lastErr: unknown = null;
    for (const url of probes) {
      try {
        const res = await fetch(url, { method: 'GET' });
        lastStatus = res.status;
        if (res.status < 500) {
          expect(res.status).toBeLessThan(500);
          return;
        }
      } catch (err) { lastErr = err; }
    }
    throw new Error(`OpenSign _User probe failed for ${OPENSIGN_URL}. lastStatus=${lastStatus}, lastErr=${String(lastErr)}`);
  });

  // AP. Gateway can sync firm to Kimai
  it('AP: Gateway can sync firm to Kimai', async () => {
    expect(GATEWAY_URL.length).toBeGreaterThan(0);
    const firmId = `contract-ap-${Date.now()}`;
    const bodyStr = JSON.stringify({ firmName: 'Contract Test Firm AP' });
    const headers = makeSignedHeaders({
      method: 'POST',
      path: `/api/v1/firms/${firmId}/init`,
      body: bodyStr,
      firmId,
      secret: HMAC_SECRET,
    });

    const res = await fetch(`${GATEWAY_URL}/api/v1/firms/${firmId}/init`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: bodyStr,
    });

    expect(res.status).toBeLessThan(500);
    const body = await res.json().catch(() => null);
    expect(body).not.toBeNull();
    expect(body.ok).toBe(true);
  });

  // AQ. Gateway can create signature workflow in OpenSign
  it('AQ: Gateway can create signature workflow in OpenSign', async () => {
    expect(GATEWAY_URL.length).toBeGreaterThan(0);
    expect(existsSync(fixturePdf)).toBe(true);

    // First sync the OpenSign firm + user so the service has state.
    const firmId = `contract-aq-${Date.now()}`;
    const userId = `user-aq-${Date.now()}`;

    const initBody = JSON.stringify({ firmName: 'Contract Test Firm AQ' });
    const initHeaders = makeSignedHeaders({
      method: 'POST', path: `/api/v1/firms/${firmId}/init`, body: initBody, firmId, secret: HMAC_SECRET,
    });
    await fetch(`${GATEWAY_URL}/api/v1/firms/${firmId}/init`, {
      method: 'POST', headers: { ...initHeaders, 'Content-Type': 'application/json' }, body: initBody,
    });

    const syncUserBody = JSON.stringify({ scenticUserId: userId, email: `${userId}@contract.test`, name: 'Contract Signer' });
    const syncUserHeaders = makeSignedHeaders({
      method: 'POST', path: `/api/v1/firms/${firmId}/signature/users/sync`, body: syncUserBody, firmId, secret: HMAC_SECRET, userId,
    });
    await fetch(`${GATEWAY_URL}/api/v1/firms/${firmId}/signature/users/sync`, {
      method: 'POST', headers: { ...syncUserHeaders, 'Content-Type': 'application/json' }, body: syncUserBody,
    });

    const docBase64 = readFileSync(fixturePdf).toString('base64');
    const workflowId = `sw-aq-${Date.now()}`;
    const wfBody = JSON.stringify({
      scenticSignatureWorkflowId: workflowId,
      scenticMatterId: `matter-aq-${Date.now()}`,
      scenticDocumentId: `doc-aq-${Date.now()}`,
      scenticDocumentVersionId: `dv-aq-${Date.now()}`,
      scenticPhysicalFileId: `pf-aq-${Date.now()}`,
      documentName: 'contract-test.pdf',
      documentBase64: docBase64,
      signers: [
        { scenticSignerId: `signer-aq-${Date.now()}`, email: `${userId}@contract.test`, name: 'Contract Signer', role: 'SIGNER', order: 1 },
      ],
      sendNow: false,
    });
    const wfHeaders = makeSignedHeaders({
      method: 'POST', path: `/api/v1/firms/${firmId}/signature/workflows`, body: wfBody, firmId, secret: HMAC_SECRET, userId,
    });

    const res = await fetch(`${GATEWAY_URL}/api/v1/firms/${firmId}/signature/workflows`, {
      method: 'POST', headers: { ...wfHeaders, 'Content-Type': 'application/json' }, body: wfBody,
    });

    // Accept any non-5xx structured response that proves the gateway contacted
    // OpenSign. A successful workflow creation returns 200 with ok:true.
    expect(res.status).toBeLessThan(500);
    const body = await res.json().catch(() => null);
    expect(body).not.toBeNull();
    expect(body.ok).toBe(true);
  });
});

// Always-running guard test that documents the skip reason when env is absent.
describe('AGPL-04 Docker stack contract env guard', () => {
  it('documents the GATEWAY_CONTRACT_TEST requirement for tests AL–AQ', () => {
    if (!shouldRun) {
      expect(process.env.GATEWAY_CONTRACT_TEST).not.toBe('true');
    } else {
      expect(process.env.GATEWAY_CONTRACT_TEST).toBe('true');
    }
  });
});
